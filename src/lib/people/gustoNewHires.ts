// New in Gusto: an ON-DEMAND pull that shows only the people in Gusto who are not in People yet, with what
// Connecteam setup needs (legal name, birth date, phone, personal email, start date).
//
// Flow (one "Sync Gusto now"): the Auto-Pull extension's gusto.js reads Gusto's roster (including pending
// hires still onboarding, and draft offers) and posts ONLY names, titles and dates here. This module works
// out the delta against People and answers with the Gusto ids that are net new. The extension then reads
// the personal details for THOSE ids only and posts them back. Details for anyone else are refused, so the
// app never collects birth dates for people it already has.
//
// A Gusto person already in People (linked gusto_id, linked payroll worker, or one exact full-name match)
// is not new: the Gusto id is linked onto that record instead (audited). Nothing is added to People until
// an owner/admin presses Add.

import { getJson, setJson } from "@/lib/kv";
import { insertAudit } from "@/lib/db/repo";
import { listWorkerRecords } from "@/lib/payroll/store";
import { todayInOpsTz } from "@/lib/dates";
import { toE164 } from "@/lib/notify/sms";
import { createEmployee, getPolicy, linkEmployee, listEmployees } from "./store";
import { deriveWorkEmail, policyIssuesWorkEmail } from "./policy";
import { nameKey, policyForTitle } from "./match";
import { announceNewHire } from "./notify";
import type { Employee } from "./types";

const LIST_KEY = "people.gustoNew";
const HIDDEN_KEY = "people.gustoHidden";

/** One person from the Gusto roster pull (no personal details). */
export interface GustoRosterPerson {
  id: string;
  source: "member" | "draft"; // draft = an offer not sent / not accepted yet (no Gusto member to read)
  firstName: string;
  lastName: string;
  preferredName: string | null;
  jobTitle: string | null;
  workerType: string | null; // EMPLOYEE | CONTRACTOR | ...
  startDate: string | null; // YYYY-MM-DD
  endDate: string | null;
  setupStatus: string | null; // COMPLETED once Gusto onboarding is done
  offerStatus: string | null;
}

/** Personal details read for a net-new person only. */
export interface GustoPersonDetails {
  id: string;
  legalFirstName: string | null;
  legalLastName: string | null;
  birthDate: string | null;
  phone: string | null; // E.164
  personalEmail: string | null;
  startDate: string | null;
}

export interface GustoNewHire extends GustoRosterPerson {
  details: GustoPersonDetails | null;
}

export interface GustoNewHireList {
  pulledAt: string;
  people: GustoNewHire[];
  linked: { employeeId: string; name: string; via: string }[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const isoDate = (v: unknown): string | null => {
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};

/** Display name for a Gusto person: preferred name when set, else legal first + last. PURE. */
export function gustoDisplayName(p: Pick<GustoRosterPerson, "firstName" | "lastName" | "preferredName">): string {
  return p.preferredName ?? `${p.firstName} ${p.lastName}`.trim();
}

// ── Parsing (PURE) ───────────────────────────────────────────────────────────────────────────────────
// Shapes captured live 2026-11-05 from the ZoeNewHireRoster / ZoeNewHireOnboarding / ZoeNewHireDetails
// queries that extension/gusto.js sends (trimmed versions of Gusto's MembersTable,
// OnboardingTableExpandedDetails and CompanyMemberDashboardPeopleShowPersonal).

function memberToPerson(n: Record<string, unknown>): GustoRosterPerson | null {
  const id = str(n.id);
  if (!id) return null;
  const latest = (n.latestEmployment ?? {}) as Record<string, unknown>;
  const upcoming = (n.upcomingEmployment ?? {}) as Record<string, unknown>;
  const offer = (n.offer ?? {}) as Record<string, unknown>;
  return {
    id,
    source: "member",
    firstName: str(n.legalFirstName) ?? "",
    lastName: str(n.lastName) ?? "",
    preferredName: str(n.preferredFullName),
    jobTitle: str(n.jobTitle),
    workerType: str(latest.workerType) ?? str(upcoming.workerType),
    startDate: isoDate(upcoming.startDate) ?? isoDate(latest.startDate),
    endDate: isoDate(latest.endDate),
    setupStatus: str(upcoming.setupStatus) ?? str(latest.setupStatus),
    offerStatus: str(offer.status),
  };
}

/** Parse the roster + onboarding responses into one de-duplicated list. Never throws. */
export function parseGustoRoster(roster: unknown, onboarding: unknown): GustoRosterPerson[] {
  const out = new Map<string, GustoRosterPerson>();
  const company = (roster as { data?: { company?: Record<string, unknown> } })?.data?.company ?? {};
  const members = (company.members ?? {}) as { edges?: Array<{ node?: Record<string, unknown> }>; nodes?: Record<string, unknown>[] };
  const nodes = Array.isArray(members.edges) ? members.edges.map((e) => e?.node) : Array.isArray(members.nodes) ? members.nodes : [];
  for (const n of nodes) {
    const p = n ? memberToPerson(n) : null;
    if (p) out.set(p.id, p);
  }
  const onb = (onboarding as { data?: { company?: { onboarding?: { nodes?: Record<string, unknown>[] } } } })?.data?.company?.onboarding?.nodes;
  for (const n of Array.isArray(onb) ? onb : []) {
    const p = n ? memberToPerson(n) : null;
    if (p) out.set(p.id, { ...(out.get(p.id) ?? {}), ...p });
  }
  const drafts = (company.draftTeamMembers as { nodes?: Record<string, unknown>[] } | undefined)?.nodes;
  for (const d of Array.isArray(drafts) ? drafts : []) {
    const id = str(d?.id);
    if (!id) continue;
    out.set(`draft:${id}`, {
      id: `draft:${id}`,
      source: "draft",
      firstName: str(d.legalFirstName) ?? "",
      lastName: str(d.lastName) ?? "",
      preferredName: str(d.preferredFirstName) ? `${str(d.preferredFirstName)} ${str(d.lastName) ?? ""}`.trim() : null,
      jobTitle: null,
      workerType: str(d.teamMemberType),
      startDate: isoDate(d.startDate),
      endDate: null,
      setupStatus: "DRAFT",
      offerStatus: d.sendOffer === true ? "draft offer" : null,
    });
  }
  return [...out.values()].filter((p) => p.firstName || p.lastName || p.preferredName);
}

/** Parse one ZoeNewHireDetails response. Only the fields we use; anything else is dropped. PURE. */
export function parseGustoDetails(id: string, raw: unknown): GustoPersonDetails | null {
  const person = (raw as { data?: { member?: { company?: { person?: Record<string, unknown> } } } })?.data?.member?.company?.person;
  if (!person) return null;
  const legal = (person.currentLegalName ?? {}) as Record<string, unknown>;
  const phoneObj = (person.phoneNumber ?? {}) as Record<string, unknown>;
  const digits = String(phoneObj.number ?? "").replace(/\D/g, "");
  const cc = String(phoneObj.callingCode ?? "1").replace(/\D/g, "") || "1";
  const phone = digits ? toE164(digits.length === 10 && cc === "1" ? digits : `+${cc}${digits}`) || null : null;
  const latest = (person.latestEmployment ?? {}) as Record<string, unknown>;
  const upcoming = (person.upcomingEmployment ?? {}) as Record<string, unknown>;
  return {
    id,
    legalFirstName: str(legal.firstName),
    legalLastName: str(legal.lastName),
    birthDate: isoDate(person.birthday),
    phone,
    personalEmail: str(person.email)?.toLowerCase() ?? null,
    startDate: isoDate(upcoming.startDate) ?? isoDate(latest.startDate),
  };
}

// ── The delta (PURE) ─────────────────────────────────────────────────────────────────────────────────
export interface DeltaInput {
  roster: GustoRosterPerson[];
  employees: Employee[];
  workers: { id: string; gustoId: string | null }[];
  hidden: string[];
  today: string;
}

export interface DeltaResult {
  netNew: GustoRosterPerson[];
  links: { employeeId: string; gustoId: string; via: string }[];
}

export function planGustoDelta(input: DeltaInput): DeltaResult {
  const netNew: GustoRosterPerson[] = [];
  const links: DeltaResult["links"] = [];
  const hasGusto = new Set(input.employees.map((e) => e.gustoId).filter((v): v is string => !!v));
  const claimed = new Set<string>();
  for (const p of input.roster) {
    if (hasGusto.has(p.id) || input.hidden.includes(p.id)) continue;
    if (p.endDate && p.endDate < input.today) continue; // already left
    if (p.source === "member") {
      // Linked through payroll: the payroll worker carries this Gusto id and is linked to a person.
      const w = input.workers.find((x) => x.gustoId === p.id);
      const viaWorker = w ? input.employees.find((e) => e.hrWorkerId === w.id && !e.gustoId) : undefined;
      if (viaWorker && !claimed.has(viaWorker.id)) {
        links.push({ employeeId: viaWorker.id, gustoId: p.id, via: "payroll worker" });
        claimed.add(viaWorker.id);
        continue;
      }
    }
    const key = nameKey(gustoDisplayName(p));
    const legalKey = nameKey(`${p.firstName} ${p.lastName}`);
    const byName = input.employees.filter(
      (e) => !e.gustoId && !claimed.has(e.id) && e.lifecycleState !== "OFFBOARDED" && [key, legalKey].includes(nameKey(e.displayName)),
    );
    if (byName.length === 1) {
      // A draft has no Gusto member id yet, so it is "already in People" but there is nothing to link.
      if (p.source === "member") links.push({ employeeId: byName[0].id, gustoId: p.id, via: "full name" });
      claimed.add(byName[0].id);
      continue;
    }
    netNew.push(p);
  }
  return { netNew, links };
}

// ── IO: store, ingest, add, hide ─────────────────────────────────────────────────────────────────────
function audit(actor: string, action: string, entityId: string, after: unknown): void {
  try {
    insertAudit({ actor, action, entity: "employee", entityId, before: null, after });
  } catch {
    /* audit best effort */
  }
}

export function gustoNewHireList(): GustoNewHireList | null {
  return getJson<GustoNewHireList | null>(LIST_KEY, null);
}

function hiddenIds(): string[] {
  return Object.keys(getJson<Record<string, unknown>>(HIDDEN_KEY, {}));
}

/** Ingest the roster from the extension: link known people, store the net new, return ids to read. */
export function ingestGustoRoster(roster: GustoRosterPerson[]): { netNew: number; linked: number; needDetails: string[] } {
  const prev = gustoNewHireList();
  const { netNew, links } = planGustoDelta({
    roster,
    employees: listEmployees(),
    workers: listWorkerRecords().map((w) => ({ id: w.id, gustoId: w.gustoId })),
    hidden: hiddenIds(),
    today: todayInOpsTz(),
  });
  const linked: GustoNewHireList["linked"] = [];
  for (const l of links) {
    linkEmployee(l.employeeId, "gusto_id", l.gustoId);
    const name = listEmployees().find((e) => e.id === l.employeeId)?.displayName ?? l.employeeId;
    audit("Gusto pull", "IDENTITY_LINKED", `${l.employeeId}:gusto_id`, { field: "gusto_id", value: l.gustoId, detail: `Linked Gusto by ${l.via}.` });
    linked.push({ employeeId: l.employeeId, name, via: l.via });
  }
  // Keep details already read for someone still net new; drop everyone else's.
  const people: GustoNewHire[] = netNew.map((p) => ({ ...p, details: prev?.people.find((x) => x.id === p.id)?.details ?? null }));
  setJson(LIST_KEY, { pulledAt: new Date().toISOString(), people, linked } satisfies GustoNewHireList);
  return { netNew: people.length, linked: linked.length, needDetails: people.filter((p) => p.source === "member").map((p) => p.id) };
}

/** Ingest personal details. Accepted ONLY for people currently on the net-new list. */
export function ingestGustoDetails(details: GustoPersonDetails[]): { stored: number; refused: number } {
  const list = gustoNewHireList();
  if (!list) return { stored: 0, refused: details.length };
  let stored = 0;
  let refused = 0;
  for (const d of details) {
    const p = list.people.find((x) => x.id === d.id);
    if (!p) {
      refused++;
      continue;
    }
    p.details = d;
    stored++;
  }
  setJson(LIST_KEY, list);
  return { stored, refused };
}

/** Add one net-new Gusto person to People as a HIRE. Owner/admin action, attributed. */
export function addFromGusto(id: string, policyId: string, actor: string): { ok: boolean; message: string; employeeId?: string } {
  const list = gustoNewHireList();
  const p = list?.people.find((x) => x.id === id);
  if (!list || !p) return { ok: false, message: "That person is no longer on the New in Gusto list. Pull again." };
  const policy = getPolicy(policyId);
  if (!policy) return { ok: false, message: "Pick an access policy." };
  const d = p.details;
  const first = d?.legalFirstName ?? p.firstName;
  const last = d?.legalLastName ?? p.lastName;
  const displayName = p.preferredName ?? `${first} ${last}`.trim();
  const emp = createEmployee({
    displayName,
    workEmail: policyIssuesWorkEmail(policy) ? deriveWorkEmail(displayName) : null,
    phone: d?.phone ?? null,
    birthDate: d?.birthDate ?? null,
    personalEmail: d?.personalEmail ?? null,
    role: "member",
    department: policy.id,
    startDate: d?.startDate ?? p.startDate,
    gustoId: p.source === "member" ? p.id : null,
  });
  audit(actor, "EMPLOYEE_ADDED_FROM_GUSTO", emp.id, { gustoId: p.id, detail: `Added ${displayName} from Gusto.` });
  setJson(LIST_KEY, { ...list, people: list.people.filter((x) => x.id !== id) } satisfies GustoNewHireList);
  announceNewHire(emp, policy.name, actor);
  return { ok: true, message: `Added ${displayName}.`, employeeId: emp.id };
}

/** Keep someone off the list (for example an owner or a contractor People does not track). Attributed. */
export function hideFromGusto(id: string, actor: string): { ok: boolean; message: string } {
  const list = gustoNewHireList();
  const p = list?.people.find((x) => x.id === id);
  if (!list || !p) return { ok: false, message: "Not on the list." };
  const hidden = getJson<Record<string, { by: string; at: string; name: string }>>(HIDDEN_KEY, {});
  hidden[id] = { by: actor, at: new Date().toISOString(), name: gustoDisplayName(p) };
  setJson(HIDDEN_KEY, hidden);
  setJson(LIST_KEY, { ...list, people: list.people.filter((x) => x.id !== id) } satisfies GustoNewHireList);
  audit(actor, "GUSTO_PERSON_HIDDEN", `gusto:${id}`, { name: gustoDisplayName(p) });
  return { ok: true, message: `${gustoDisplayName(p)} will not be listed again.` };
}

/** The suggested policy for a Gusto person, from their job title. PURE. */
export function suggestedPolicy(p: Pick<GustoRosterPerson, "jobTitle">): string {
  return policyForTitle(p.jobTitle) ?? "sales_associate";
}
