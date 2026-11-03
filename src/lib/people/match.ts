// Staff matching (PURE). Ties the people who already work here to a People record, across Connecteam (the
// staff roster), Zoe logins, and payroll workers, so offboarding anyone has real links to act on.
//
// Rules:
//  - Link only on a CONFIDENT, UNIQUE match: an exact id, an exact phone or email, or an exact full name.
//  - Never overwrite an existing link, and never give one id to two people.
//  - Anything less (two candidates, first name only, nobody found) becomes an EXCEPTION with the reason,
//    plus a suggested link when there is one. An exception goes away only when the link really exists.
//  - Someone on the Connecteam roster with no People record is added as existing staff (ACTIVE) once their
//    Connecteam account is at least NEW_STAFF_GRACE_DAYS old. Newer people are flagged instead, so a hire
//    who is going through onboarding is never imported twice.

import type { Employee } from "./types";

export const NEW_STAFF_GRACE_DAYS = 14;

export interface RosterPerson {
  userId: number;
  name: string;
  phone?: string | null;
  email?: string | null;
  title?: string | null;
  seniorityDate?: string | null;
}

export interface ZoeLogin {
  id: string;
  username: string;
  name: string;
  role: string;
  active: boolean;
  openphoneUserId: string | null;
}

export interface PayrollWorker {
  id: string;
  name: string;
  email: string | null;
  connecteamUserId: number | null;
  gustoId: string | null;
  active: boolean;
  excluded: boolean;
}

export interface MatchInput {
  employees: Employee[];
  roster: RosterPerson[];
  /** False when Connecteam was unreachable or unconfigured: no roster based exceptions are raised. */
  rosterOk: boolean;
  logins: ZoeLogin[];
  workers: PayrollWorker[];
  /** YYYY-MM-DD in the ops timezone. */
  today: string;
  /** Policy ids that include a Connecteam step (so "not in Connecteam" is a real gap). */
  connecteamPolicies: string[];
}

export type LinkField = "connecteam_user_id" | "user_id" | "hr_worker_id" | "gusto_id" | "openphone_user_id" | "phone";

export interface CreateAction {
  kind: "create";
  person: RosterPerson;
  policyId: string | null;
  role: "owner" | "admin" | "member";
  phone: string | null;
  workEmail: string | null;
}

export interface LinkAction {
  kind: "link";
  employeeId: string;
  field: LinkField;
  value: string | number;
  via: string;
}

export interface MatchSuggestion {
  employeeId: string;
  employeeName: string;
  field: LinkField;
  value: string | number;
}

export type ExceptionKind = "ambiguous" | "probable" | "no_match" | "new_in_connecteam" | "missing_in_connecteam" | "no_policy";

export interface MatchException {
  key: string; // stable, for dedupe
  kind: ExceptionKind;
  system: "connecteam" | "zoe" | "payroll" | "people";
  subject: string; // who or what, in plain words
  detail: string;
  employeeId?: string;
  suggestions: MatchSuggestion[];
}

export interface MatchPlan {
  creates: CreateAction[];
  links: LinkAction[];
  exceptions: MatchException[];
}

// ── Normalizers (PURE) ───────────────────────────────────────────────────────────────────────────────
export function normName(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/** "first last" from any name (first and last word), so middle names do not block a match. */
export function nameKey(s: string | null | undefined): string {
  const w = normName(s).split(" ").filter(Boolean);
  if (w.length <= 1) return w[0] ?? "";
  return `${w[0]} ${w[w.length - 1]}`;
}

export function firstName(s: string | null | undefined): string {
  return normName(s).split(" ")[0] ?? "";
}

export function normPhone(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  const d = t.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (t.startsWith("+") && d.length >= 8) return `+${d}`;
  return null;
}

export function normEmail(raw: string | null | undefined): string | null {
  const e = (raw ?? "").trim().toLowerCase();
  return e.includes("@") ? e : null;
}

/** Access policy for a Connecteam Title. Null when no policy fits (raised as an exception). PURE. */
export function policyForTitle(title: string | null | undefined): string | null {
  const t = (title ?? "").toLowerCase();
  if (!t) return null;
  if (/driver/.test(t)) return "driver";
  if (/warehouse|asset|prep/.test(t)) return "warehouse";
  if (/sales/.test(t)) return "sales_associate";
  if (/co.?founder|owner|admin|office/.test(t)) return "admin";
  if (/manager/.test(t)) return "manager";
  if (/operation|dispatch/.test(t)) return "operations";
  return null;
}

/** Zoe role for an imported staff record (informational; access still comes from the policy). PURE. */
export function roleForTitle(title: string | null | undefined): "owner" | "admin" | "member" {
  const t = (title ?? "").toLowerCase();
  if (/co.?founder|owner/.test(t)) return "owner";
  if (/admin|manager/.test(t)) return "admin";
  return "member";
}

function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.floor((Date.parse(`${toYmd}T12:00:00Z`) - Date.parse(`${fromYmd.slice(0, 10)}T12:00:00Z`)) / 86_400_000);
}

// ── The planner (PURE) ───────────────────────────────────────────────────────────────────────────────
export function planMatches(input: MatchInput): MatchPlan {
  const creates: CreateAction[] = [];
  const links: LinkAction[] = [];
  const exceptions: MatchException[] = [];

  // Live people only (an offboarded record keeps its links but is never matched to someone new).
  const live = input.employees.filter((e) => e.lifecycleState !== "OFFBOARDED");
  // Working copy of each person's links, updated as this plan links them (so one pass stays consistent).
  const ct = new Map<string, number | null>(live.map((e) => [e.id, e.connecteamUserId]));
  const uid = new Map<string, string | null>(live.map((e) => [e.id, e.userId]));
  const hw = new Map<string, string | null>(live.map((e) => [e.id, e.hrWorkerId]));
  const takenCt = new Set(input.employees.map((e) => e.connecteamUserId).filter((v): v is number => v != null));
  const takenUid = new Set(input.employees.map((e) => e.userId).filter((v): v is string => !!v));
  const takenHw = new Set(input.employees.map((e) => e.hrWorkerId).filter((v): v is string => !!v));

  const link = (employeeId: string, field: LinkField, value: string | number, via: string): void => {
    links.push({ kind: "link", employeeId, field, value, via });
  };
  const sugg = (e: Employee, field: LinkField, value: string | number): MatchSuggestion => ({ employeeId: e.id, employeeName: e.displayName, field, value });

  // 1) Connecteam roster ↔ People
  const rosterById = new Map<number, RosterPerson>();
  if (input.rosterOk) {
    for (const p of input.roster) {
      rosterById.set(p.userId, p);
      const holder = live.find((e) => ct.get(e.id) === p.userId);
      if (holder) {
        if (!holder.phone && normPhone(p.phone)) link(holder.id, "phone", normPhone(p.phone)!, "Connecteam phone");
        continue;
      }
      if (takenCt.has(p.userId)) continue; // linked to an offboarded record
      const open = live.filter((e) => ct.get(e.id) == null);
      const phone = normPhone(p.phone);
      const email = normEmail(p.email);
      const byPhone = phone ? open.filter((e) => normPhone(e.phone) === phone) : [];
      const byEmail = email ? open.filter((e) => normEmail(e.workEmail) === email) : [];
      const byName = nameKey(p.name) ? open.filter((e) => nameKey(e.displayName) === nameKey(p.name)) : [];
      const strong = [...new Set([...byPhone, ...byEmail])];
      let pick: Employee | null = null;
      let via = "";
      let ambiguous: Employee[] = [];
      if (strong.length === 1) {
        pick = strong[0];
        via = byPhone.includes(pick) ? "phone" : "email";
        if (byName.length > 0 && !byName.includes(pick)) { ambiguous = [pick, ...byName]; pick = null; }
      } else if (strong.length > 1) {
        ambiguous = strong;
      } else if (byName.length === 1) {
        pick = byName[0];
        via = "full name";
      } else if (byName.length > 1) {
        ambiguous = byName;
      }
      if (pick) {
        ct.set(pick.id, p.userId);
        takenCt.add(p.userId);
        link(pick.id, "connecteam_user_id", p.userId, `Connecteam ${via}`);
        if (!pick.phone && phone) link(pick.id, "phone", phone, "Connecteam phone");
        continue;
      }
      if (ambiguous.length > 0) {
        exceptions.push({
          key: `ambiguous:connecteam:${p.userId}`,
          kind: "ambiguous",
          system: "connecteam",
          subject: p.name,
          detail: `Connecteam user ${p.name} could be ${ambiguous.map((e) => e.displayName).join(" or ")}. Pick the right person.`,
          suggestions: ambiguous.map((e) => sugg(e, "connecteam_user_id", p.userId)),
        });
        continue;
      }
      // Nobody in People: import established staff, flag recent ones.
      const age = p.seniorityDate ? daysBetween(p.seniorityDate, input.today) : null;
      if (age != null && age < NEW_STAFF_GRACE_DAYS) {
        exceptions.push({
          key: `new_in_connecteam:${p.userId}`,
          kind: "new_in_connecteam",
          system: "connecteam",
          subject: p.name,
          detail: `${p.name} joined Connecteam ${Math.max(age, 0)} day${age === 1 ? "" : "s"} ago and is not in People. Add them through onboarding, or they are added as existing staff after ${NEW_STAFF_GRACE_DAYS} days.`,
          suggestions: [],
        });
        continue;
      }
      const em = normEmail(p.email);
      creates.push({
        kind: "create",
        person: p,
        policyId: policyForTitle(p.title),
        role: roleForTitle(p.title),
        phone,
        workEmail: em && em.endsWith("@zoeeventsdmv.com") ? em : null,
      });
    }
  }

  // 2) Zoe logins ↔ People (active logins only; a deactivated login has nothing to revoke)
  for (const l of input.logins.filter((x) => x.active)) {
    const holder = live.find((e) => uid.get(e.id) === l.id);
    if (holder) {
      if (!holder.openphoneUserId && l.openphoneUserId) link(holder.id, "openphone_user_id", l.openphoneUserId, "Zoe login Quo link");
      continue;
    }
    if (takenUid.has(l.id)) continue;
    const open = live.filter((e) => !uid.get(e.id));
    const label = l.name && l.name !== l.username ? `${l.name} (${l.username})` : l.username;
    const fullName = nameKey(l.name).includes(" ") ? nameKey(l.name) : nameKey(l.username.replace(/[._-]+/g, " "));
    const exact = fullName.includes(" ") ? open.filter((e) => nameKey(e.displayName) === fullName) : [];
    const byMail = open.filter((e) => {
      const local = normEmail(e.workEmail)?.split("@")[0];
      return local != null && local === l.username.toLowerCase();
    });
    const strong = [...new Set([...exact, ...byMail])];
    if (strong.length === 1) {
      uid.set(strong[0].id, l.id);
      takenUid.add(l.id);
      link(strong[0].id, "user_id", l.id, exact.length ? "Zoe login full name" : "Zoe login matches work email");
      if (!strong[0].openphoneUserId && l.openphoneUserId) link(strong[0].id, "openphone_user_id", l.openphoneUserId, "Zoe login Quo link");
      continue;
    }
    if (strong.length > 1) {
      exceptions.push({
        key: `ambiguous:zoe:${l.id}`,
        kind: "ambiguous",
        system: "zoe",
        subject: label,
        detail: `Zoe login ${label} could be ${strong.map((e) => e.displayName).join(" or ")}. Pick the right person.`,
        suggestions: strong.map((e) => sugg(e, "user_id", l.id)),
      });
      continue;
    }
    const first = firstName(l.name) || firstName(l.username.replace(/[._-]+/g, " "));
    const byFirst = first ? open.filter((e) => firstName(e.displayName) === first) : [];
    if (byFirst.length >= 1) {
      exceptions.push({
        key: `probable:zoe:${l.id}`,
        kind: byFirst.length === 1 ? "probable" : "ambiguous",
        system: "zoe",
        subject: label,
        detail: byFirst.length === 1
          ? `Zoe login ${label} is probably ${byFirst[0].displayName} (first name only). Confirm to link it.`
          : `Zoe login ${label} could be ${byFirst.map((e) => e.displayName).join(" or ")} (first name only). Pick the right person.`,
        suggestions: byFirst.map((e) => sugg(e, "user_id", l.id)),
      });
      continue;
    }
    exceptions.push({
      key: `no_match:zoe:${l.id}`,
      kind: "no_match",
      system: "zoe",
      subject: label,
      detail: `Zoe login ${label} (${l.role}) is not tied to anyone in People, so nobody's offboarding would turn it off.`,
      suggestions: [],
    });
  }

  // 3) Payroll workers ↔ People
  for (const w of input.workers.filter((x) => x.active && !x.excluded)) {
    const holder = live.find((e) => hw.get(e.id) === w.id);
    if (holder) {
      if (!holder.gustoId && w.gustoId) link(holder.id, "gusto_id", w.gustoId, "payroll Gusto mapping");
      continue;
    }
    if (takenHw.has(w.id)) continue;
    const open = live.filter((e) => !hw.get(e.id));
    const viaCt = w.connecteamUserId != null ? open.filter((e) => ct.get(e.id) === w.connecteamUserId) : [];
    const viaName = open.filter((e) => nameKey(e.displayName) === nameKey(w.name));
    const pick = viaCt.length === 1 ? viaCt[0] : viaCt.length === 0 && viaName.length === 1 ? viaName[0] : null;
    if (pick) {
      hw.set(pick.id, w.id);
      takenHw.add(w.id);
      link(pick.id, "hr_worker_id", w.id, viaCt.length ? "payroll Connecteam id" : "payroll full name");
      if (!pick.gustoId && w.gustoId) link(pick.id, "gusto_id", w.gustoId, "payroll Gusto mapping");
      continue;
    }
    // A roster person about to be imported will match on the next pass; do not flag them now.
    if (w.connecteamUserId != null && creates.some((c) => c.person.userId === w.connecteamUserId)) continue;
    const cands = viaCt.length > 1 ? viaCt : viaName;
    exceptions.push({
      key: `${cands.length > 1 ? "ambiguous" : "no_match"}:payroll:${w.id}`,
      kind: cands.length > 1 ? "ambiguous" : "no_match",
      system: "payroll",
      subject: w.name,
      detail: cands.length > 1
        ? `Payroll worker ${w.name} could be ${cands.map((e) => e.displayName).join(" or ")}. Pick the right person.`
        : `Payroll worker ${w.name} is not in People.`,
      suggestions: cands.map((e) => sugg(e, "hr_worker_id", w.id)),
    });
  }

  // 4) People records with a gap that would bite at offboarding.
  for (const e of live) {
    if (e.lifecycleState === "HIRE") continue; // not set up anywhere yet, by design
    if (!e.department) {
      exceptions.push({
        key: `no_policy:${e.id}`,
        kind: "no_policy",
        system: "people",
        subject: e.displayName,
        detail: `${e.displayName} has no access policy, so offboarding would have no checklist. Set their policy.`,
        employeeId: e.id,
        suggestions: [],
      });
    }
    if (input.rosterOk && ct.get(e.id) == null && e.department && input.connecteamPolicies.includes(e.department)) {
      exceptions.push({
        key: `missing_in_connecteam:${e.id}`,
        kind: "missing_in_connecteam",
        system: "connecteam",
        subject: e.displayName,
        detail: `${e.displayName} is not linked to a Connecteam user.`,
        employeeId: e.id,
        suggestions: [],
      });
    } else if (input.rosterOk && ct.get(e.id) != null && !rosterById.has(ct.get(e.id)!) && e.lifecycleState === "ACTIVE") {
      exceptions.push({
        key: `missing_in_connecteam:${e.id}`,
        kind: "missing_in_connecteam",
        system: "connecteam",
        subject: e.displayName,
        detail: `${e.displayName} is linked to Connecteam user #${ct.get(e.id)}, who is no longer on the active roster. Check whether they left.`,
        employeeId: e.id,
        suggestions: [],
      });
    }
  }
  return { creates, links, exceptions };
}
