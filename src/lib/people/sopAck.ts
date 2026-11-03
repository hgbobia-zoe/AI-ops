// SOP sign off: a one-time link the hire opens (no login) to read their role SOP and sign it. The token is
// the credential (random, unguessable). Signing completes the onboarding "Sign the SOP" task with the
// hire's typed name + the SOP version as evidence, audits it, and posts to #hiring.

import { randomBytes } from "node:crypto";
import { getJson, setJson } from "@/lib/kv";
import { appUrl } from "@/lib/notify/aiBots";
import { insertAudit } from "@/lib/db/repo";
import { markTaskComplete } from "./lifecycle";
import { getEmployee, listTasks, updateTask } from "./store";
import { sopFor, type Sop } from "./sop";
import { announceSopSigned } from "./notify";
import type { Employee } from "./types";

export const SOP_ADAPTER = "sop_ack";
const KEY = "people.sopAck";

interface AckRec {
  employeeId: string;
  taskId: string;
  sopId: string;
  createdAt: string;
  signedAt?: string;
  signedName?: string;
  version?: string;
}

function all(): Record<string, AckRec> {
  return getJson<Record<string, AckRec>>(KEY, {});
}

export function sopLink(token: string): string {
  return appUrl(`/ack/${token}`) ?? `/ack/${token}`;
}

/** Mint (once) the sign off link for an employee whose policy has an SOP task. Idempotent. */
export function ensureSopLink(emp: Employee): string | null {
  const sop = sopFor(emp.department);
  const task = listTasks(emp.id, "provision").find((t) => t.adapterId === SOP_ADAPTER);
  if (!sop || !task) return null;
  const recs = all();
  const existing = Object.entries(recs).find(([, r]) => r.taskId === task.id);
  if (existing) return sopLink(existing[0]);
  const token = randomBytes(24).toString("base64url");
  recs[token] = { employeeId: emp.id, taskId: task.id, sopId: sop.id, createdAt: new Date().toISOString() };
  setJson(KEY, recs);
  const link = sopLink(token);
  updateTask(task.id, { externalRef: link });
  return link;
}

export type AckView =
  | { state: "invalid" }
  | { state: "signed"; name: string; signedAt: string; sop: Sop }
  | { state: "open"; employeeName: string; sop: Sop };

export function ackView(token: string): AckView {
  const rec = all()[token];
  const sop = rec ? sopFor(rec.sopId) : null;
  if (!rec || !sop) return { state: "invalid" };
  if (rec.signedAt) return { state: "signed", name: rec.signedName ?? "", signedAt: rec.signedAt, sop };
  const emp = getEmployee(rec.employeeId);
  if (!emp || emp.lifecycleState === "OFFBOARD" || emp.lifecycleState === "OFFBOARDED") return { state: "invalid" };
  return { state: "open", employeeName: emp.displayName, sop };
}

/** The "typed your own name" check: case, accents, spacing and punctuation do not matter. PURE. */
export function sameName(a: string, b: string): boolean {
  const n = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
  return n(a).length > 0 && n(a) === n(b);
}

export function signSop(token: string, typedName: string): { ok: boolean; error?: string } {
  const recs = all();
  const rec = recs[token];
  const view = ackView(token);
  if (!rec || view.state === "invalid") return { ok: false, error: "This link is not valid." };
  if (view.state === "signed") return { ok: true };
  if (!sameName(typedName, view.employeeName)) return { ok: false, error: "Type your full name as it appears above." };
  const now = new Date().toISOString();
  const actor = `${typedName.trim()} (signed SOP v${view.sop.version})`;
  const r = markTaskComplete(rec.taskId, actor, `Signed ${view.sop.title} v${view.sop.version}`, { sopSigned: true });
  if (!r.ok) return { ok: false, error: "Could not record the signature. Ask your manager." };
  recs[token] = { ...rec, signedAt: now, signedName: typedName.trim(), version: view.sop.version };
  setJson(KEY, recs);
  try {
    insertAudit({ actor, action: "SOP_SIGNED", entity: "employee", entityId: rec.employeeId, before: null, after: { sop: view.sop.id, version: view.sop.version, signedAt: now } });
  } catch {
    /* audit best effort */
  }
  const emp = getEmployee(rec.employeeId);
  if (emp) announceSopSigned(emp, view.sop.title, view.sop.version);
  return { ok: true };
}
