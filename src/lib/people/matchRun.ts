// Staff matching run: gathers the roster, Zoe logins and payroll workers, applies the confident matches
// from the pure planner (match.ts), stores the report, and posts NEW exceptions to #hiring once each.
// Runs on the People tick and from the "Match now" button. Writes only our own records.

import { getUsersList, connecteamConfigured } from "@/lib/connecteam";
import { listUsers, getUser } from "@/lib/auth/users";
import { listWorkerRecords, getWorkerById } from "@/lib/payroll/store";
import { insertAudit } from "@/lib/db/repo";
import { getJson, setJson } from "@/lib/kv";
import { todayInOpsTz } from "@/lib/dates";
import { botAnnounce, appUrl } from "@/lib/notify/aiBots";
import {
  createEmployee,
  getEmployee,
  linkEmployee,
  listEmployees,
  listPolicies,
  setEmployeeConnecteamUserId,
  setEmployeePhone,
} from "./store";
import { planMatches, type LinkAction, type LinkField, type MatchException, type MatchInput } from "./match";
import { byField } from "./notify";

const REPORT_KEY = "people.matchReport";
const POSTED_KEY = "people.matchPosted";

export interface MatchReport {
  ranAt: string;
  by: string | null;
  rosterOk: boolean;
  created: { employeeId: string; name: string; policyId: string | null; source?: "connecteam" | "payroll" }[];
  linked: { employeeId: string; name: string; field: LinkField; via: string }[];
  exceptions: MatchException[];
}

export function lastMatchReport(): MatchReport | null {
  return getJson<MatchReport | null>(REPORT_KEY, null);
}

function audit(actor: string, action: string, entityId: string, after: unknown): void {
  try {
    insertAudit({ actor, action, entity: "employee", entityId, before: null, after });
  } catch {
    /* audit best effort */
  }
}

async function gather(): Promise<MatchInput> {
  const rosterOk = connecteamConfigured();
  const roster = rosterOk ? await getUsersList().catch(() => []) : [];
  const policies = listPolicies();
  return {
    employees: listEmployees(),
    roster: roster.map((m) => ({ userId: m.userId, name: m.name, phone: m.phone ?? null, email: m.email ?? null, title: m.title ?? null, seniorityDate: m.seniorityDate ?? null })),
    // An empty roster from a configured key means Connecteam did not answer: raise no roster exceptions.
    rosterOk: rosterOk && roster.length > 0,
    logins: listUsers().map((u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, active: u.active, openphoneUserId: u.openphoneUserId })),
    workers: listWorkerRecords().map((w) => ({ id: w.id, name: w.name, email: w.email, connecteamUserId: w.connecteamUserId, gustoId: w.gustoId, active: w.active, excluded: w.excluded })),
    today: todayInOpsTz(),
    connecteamPolicies: policies.filter((p) => p.rules.some((r) => r.adapterId === "connecteam")).map((p) => p.id),
  };
}

/** Apply one link. Refuses to overwrite a link that is already set. */
function applyLink(l: Pick<LinkAction, "employeeId" | "field" | "value" | "via">, actor: string): boolean {
  const e = getEmployee(l.employeeId);
  if (!e) return false;
  const current =
    l.field === "connecteam_user_id" ? e.connecteamUserId
    : l.field === "user_id" ? e.userId
    : l.field === "hr_worker_id" ? e.hrWorkerId
    : l.field === "gusto_id" ? e.gustoId
    : l.field === "openphone_user_id" ? e.openphoneUserId
    : e.phone;
  if (current != null && current !== "") return false;
  if (l.field === "connecteam_user_id") setEmployeeConnecteamUserId(e.id, Number(l.value));
  else if (l.field === "phone") setEmployeePhone(e.id, String(l.value));
  else linkEmployee(e.id, l.field, String(l.value));
  audit(actor, "IDENTITY_LINKED", `${e.id}:${l.field}`, { field: l.field, value: l.value, detail: `Linked ${l.field.replace(/_/g, " ")} by ${l.via}.` });
  return true;
}

/** Run matching end to end. `by` = the person who pressed the button, or null for the scheduled tick. */
export async function runStaffMatching(by: string | null): Promise<MatchReport> {
  const actor = by ?? "Staff matching (scheduled)";
  const created: MatchReport["created"] = [];
  const linked: MatchReport["linked"] = [];

  // Pass 1: import established staff who have no People record yet.
  const first = planMatches(await gather());
  for (const c of first.creates) {
    const emp = createEmployee({
      displayName: c.person.name,
      workEmail: c.workEmail,
      phone: c.phone,
      role: c.role,
      department: c.policyId,
      connecteamUserId: c.person.userId,
      lifecycleState: "ACTIVE",
    });
    audit(actor, "EMPLOYEE_IMPORTED", emp.id, { source: "connecteam", connecteamUserId: c.person.userId, title: c.person.title ?? null, detail: `Added ${emp.displayName} as existing staff from Connecteam.` });
    created.push({ employeeId: emp.id, name: emp.displayName, policyId: c.policyId, source: "connecteam" });
  }
  // Paid staff with nothing on the Connecteam roster: import from the payroll record (People came later).
  // Their payroll and Gusto links are made in pass 2; the access policy is left for a person to set.
  for (const c of first.payrollCreates) {
    const em = c.worker.email?.trim().toLowerCase() ?? null;
    const emp = createEmployee({
      displayName: c.worker.name,
      workEmail: em && em.endsWith("@zoeeventsdmv.com") ? em : null,
      phone: null,
      role: "member",
      department: null,
      connecteamUserId: c.worker.connecteamUserId,
      lifecycleState: "ACTIVE",
    });
    audit(actor, "EMPLOYEE_IMPORTED", emp.id, { source: "payroll", hrWorkerId: c.worker.id, detail: `Added ${emp.displayName} as existing staff from Payroll.` });
    created.push({ employeeId: emp.id, name: emp.displayName, policyId: null, source: "payroll" });
  }

  // Pass 2: link identities (now including the imported records) and collect exceptions.
  const input2 = await gather();
  const second = planMatches(input2);
  for (const l of second.links) {
    if (applyLink(l, actor)) linked.push({ employeeId: l.employeeId, name: getEmployee(l.employeeId)?.displayName ?? l.employeeId, field: l.field, via: l.via });
  }
  // Exceptions reflect the state AFTER the links (the planner already assumed them).
  const report: MatchReport = { ranAt: new Date().toISOString(), by, rosterOk: input2.rosterOk, created, linked, exceptions: second.exceptions };
  setJson(REPORT_KEY, report);
  await announce(report);
  return report;
}

/** Post a summary when something changed, and each exception the first time it appears. */
async function announce(report: MatchReport): Promise<void> {
  const posted = new Set(getJson<string[]>(POSTED_KEY, []));
  const fresh = report.exceptions.filter((x) => !posted.has(x.key));
  // Forget keys that resolved, so a gap that comes back is called out again.
  setJson(POSTED_KEY, report.exceptions.map((x) => x.key));
  if (report.created.length === 0 && report.linked.length === 0 && fresh.length === 0) return;
  const sections: string[] = [];
  if (report.created.length > 0) sections.push(`*Added as existing staff (${report.created.length})*\n${report.created.slice(0, 12).map((c) => `• ${c.name} (from ${c.source === "payroll" ? "Payroll" : "Connecteam"})`).join("\n")}`);
  if (!report.rosterOk) sections.push("_Connecteam did not answer, so importing from the roster waits for the next run._");
  if (report.linked.length > 0) sections.push(`*Linked automatically:* ${report.linked.length} account link${report.linked.length === 1 ? "" : "s"}.`);
  if (fresh.length > 0) sections.push(`*Need a person to sort out (${fresh.length})*\n${fresh.slice(0, 8).map((x) => `• ${x.detail}`).join("\n")}`);
  await botAnnounce("hiring", {
    emoji: "🔗",
    title: "Staff matching",
    fields: byField(report.by),
    sections,
    link: { text: "Open matching", url: appUrl("/people?tab=matching") },
    context: "Hiring Bot",
  }).catch(() => {});
}

export interface ManualLinkResult {
  ok: boolean;
  message: string;
}

/** A person confirms a link from an exception (a suggestion or a picked candidate). Validated, audited. */
export async function confirmLink(employeeId: string, field: LinkField, value: string | number, actor: string): Promise<ManualLinkResult> {
  const emp = getEmployee(employeeId);
  if (!emp) return { ok: false, message: "Person not found." };
  if (!["connecteam_user_id", "user_id", "hr_worker_id"].includes(field)) return { ok: false, message: "That link cannot be set here." };
  const others = listEmployees().filter((e) => e.id !== employeeId);
  if (field === "user_id") {
    if (!getUser(String(value))) return { ok: false, message: "That Zoe login no longer exists." };
    if (others.some((e) => e.userId === String(value))) return { ok: false, message: "That Zoe login is already linked to someone else." };
  } else if (field === "hr_worker_id") {
    if (!getWorkerById(String(value))) return { ok: false, message: "That payroll worker no longer exists." };
    if (others.some((e) => e.hrWorkerId === String(value))) return { ok: false, message: "That payroll worker is already linked to someone else." };
  } else {
    const n = Number(value);
    if (!(n > 0)) return { ok: false, message: "Bad Connecteam id." };
    if (others.some((e) => e.connecteamUserId === n)) return { ok: false, message: "That Connecteam user is already linked to someone else." };
  }
  if (!applyLink({ employeeId, field, value, via: `confirmation by ${actor}` }, actor)) {
    return { ok: false, message: `${emp.displayName} already has a different ${field.replace(/_/g, " ")} linked.` };
  }
  await runStaffMatching(actor);
  return { ok: true, message: `Linked to ${emp.displayName}.` };
}
