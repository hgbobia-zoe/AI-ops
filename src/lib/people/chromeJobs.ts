// Account setup that runs in the ONBOARDER's own Chrome. Slack, Quo, Google Workspace email (Squarespace),
// WeddingPro and Yelp have no public API for adding people, so the Auto-Pull extension repeats the requests
// we recorded (docs/provisioning-captures.md) inside a visible tab where whoever is onboarding is signed in.
//
// Flow: the onboarder presses "Set up in my Chrome" → startChromeRun() approves each step (same governance
// card as any automated step) and hands back one job per step, each with a one-time key → the page passes the
// jobs to the extension → the extension runs them and posts each outcome to /api/provision/result →
// applyChromeResult() checks the key and records it. Nothing here stores a password or a site token.
//
// Gates reflect reality: an email account the extension created is done; a Slack or Quo invite stays open
// until the hire actually shows up there (confirmChromeInvites, run by the People tick).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getJson, setJson } from "@/lib/kv";
import { insertAudit } from "@/lib/db/repo";
import { loadSmsConfig } from "@/lib/providers";
import { getCrewForDateSafe, getUsersList } from "@/lib/connecteam";
import { opsLocalInputToIso, todayInOpsTz } from "@/lib/dates";
import { getAdapter } from "./adapters";
import { executeAutomatedTask } from "./lifecycle";
import { PROVISION_ENDPOINTS, runsInChrome, type ReplaySystem } from "./provisioningEndpoints";
import { fillEmployeeContact, getEmployee, getTask, listTasks, setEmployeeWorkEmail, updateTask } from "./store";
import type { Employee, LifecycleTask } from "./types";

export const WORK_DOMAIN = "zoeeventsdmv.com";
/** externalRef of a step the extension holds until day one: `chrome:scheduled:<ISO time>`. */
export const CHROME_SCHEDULED_PREFIX = "chrome:scheduled:";
const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const KEY = (taskId: string): string => `people.chromejob.${taskId}`;

/** Ids recorded live 2026-11-10. Sent with each job so a change here needs no extension release. */
const SITE_CONFIG: Record<string, Record<string, unknown>> = {
  slack: { teamId: "T09F4BKDHPH", startUrl: "https://app.slack.com/client/T09F4BKDHPH" },
  quo: { startUrl: "https://my.quo.com/settings/members", lineName: "Zoe Events", role: "Member" },
  squarespace_email: {
    startUrl: "https://crocodile-chimes-jm6d.squarespace.com/config/settings/domains-email/google-workspace/account/64115bb50abb701f2a9ff04f",
    subscriptionId: "64115bb50abb701f2a9ff04f",
    contractId: "con_rDTi5p6O3pWXNr",
  },
  weddingpro: { startUrl: "https://www.weddingpro.com/settings", roleLabel: "Storefront manager" },
  // Full seat billed monthly ($59/month; annual is $49/month paid up front), as picked for the 2026-11 hire.
  whimsical: { startUrl: "https://whimsical.com/zoe-event-rentals", workspaceId: "799f8e9f-2153-40e0-90a9-569932f8b4d5", editor: true },
  goodshuffle: { startUrl: "https://pro.goodshuffle.com/app/vendorAccount/index?tab=subscription", fullUser: true, interval: "month", priceLine: "Full seat, billed monthly: $59 a month." },
  yelp: {
    startUrl: "https://biz.yelp.com/settings/user_management",
    orgId: "tsWbUrSCJa8r8SFh1UQ5ZA",
    bizEncIds: ["9Y2NgpH8DrDmjMljzAjfsg"],
    createInviteDoc: "a060c1bd2ddb73f9d0164e807328ef3b6fed111d5c4d826506e704086434e255",
    freshLoginDoc: "8cfccbf23509c6d02157dbef7d8413bd48fa36c12496b73476a5dc8c4f0099dd",
  },
};

/** Run order: the mailbox first, so the invites that follow can go to the new work address. */
const ORDER = ["squarespace_email", "slack", "quo", "goodshuffle", "weddingpro", "yelp", "whimsical"];

/** Minutes after the hire's start time that day one setup runs (the Google login email goes out then). */
export const DAY_ONE_DELAY_MIN = 10;

export interface ChromeJob {
  taskId: string;
  token: string;
  system: string;
  systemName: string;
  employeeName: string;
  resultUrl: string;
  approval: "paid" | "owner_role" | null;
  /** When set (ms epoch), the extension holds the job and runs it then: day one, 10 minutes after start. */
  runAt: number | null;
  data: Record<string, unknown>;
}

interface StoredJob { hash: string; exp: number; actor: string }

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

function asciiPart(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** firstname.lastname for the Workspace mailbox. Uses the work email's name when People already has one. PURE. */
export function mailboxUserName(emp: Pick<Employee, "displayName" | "workEmail">): string {
  const we = (emp.workEmail ?? "").trim().toLowerCase();
  if (we.endsWith(`@${WORK_DOMAIN}`)) return we.split("@")[0];
  const parts = emp.displayName.trim().split(/\s+/).map(asciiPart).filter(Boolean);
  if (parts.length === 0) return "";
  return parts.length === 1 ? parts[0] : `${parts[0]}.${parts[parts.length - 1]}`;
}

function nameParts(displayName: string): { firstName: string; lastName: string } {
  const p = displayName.trim().split(/\s+/).filter(Boolean);
  return { firstName: p[0] ?? "", lastName: p.slice(1).join(" ") };
}

/** What each site needs for this person, or the reason it can't run yet. PURE. */
export function jobData(system: string, emp: Employee, plannedWorkEmail: string | null): { data: Record<string, unknown> } | { blocked: string } {
  const { firstName, lastName } = nameParts(emp.displayName);
  const cfg = SITE_CONFIG[system] ?? {};
  if (system === "squarespace_email") {
    const userName = mailboxUserName(emp);
    if (!userName) return { blocked: "Add the hire's name first." };
    const loginTo = (emp.personalEmail ?? "").trim();
    if (!loginTo) return { blocked: "Add the hire's personal email so Google can send them the login." };
    return { data: { ...cfg, firstName, lastName, userName, newEmail: `${userName}@${WORK_DOMAIN}`, loginTo } };
  }
  const email = (emp.workEmail ?? plannedWorkEmail ?? emp.personalEmail ?? "").trim();
  if (!email) return { blocked: "Add a work or personal email first." };
  return { data: { ...cfg, firstName, lastName, email } };
}

function issue(task: LifecycleTask, actor: string, runAt: number | null): string {
  const token = randomBytes(24).toString("base64url");
  // A scheduled job keeps its key until a day after it is due (the Chrome may be off at that moment).
  const exp = runAt ? runAt + 24 * 60 * 60 * 1000 : Date.now() + JOB_TTL_MS;
  setJson(KEY(task.id), { hash: sha(token), exp, actor } satisfies StoredJob);
  return token;
}

/** The hire's day one start: their first Connecteam shift that day, else 9:00 AM ops time. PURE given inputs. */
export function dayOneStart(startDate: string, shiftStartsUnix: number[]): number | null {
  if (shiftStartsUnix.length) return Math.min(...shiftStartsUnix) * 1000;
  const iso = opsLocalInputToIso(`${startDate}T09:00`);
  return iso ? Date.parse(iso) : null;
}

/** When day one setup should run, or null to run now (no start date, or it is already past). */
async function dayOneRunAt(emp: Employee, now: number): Promise<number | null> {
  if (!emp.startDate || emp.startDate < todayInOpsTz(new Date(now))) return null;
  let starts: number[] = [];
  if (emp.connecteamUserId) {
    const day = await getCrewForDateSafe(emp.startDate).catch(() => ({ ok: false, shifts: [] }));
    starts = day.shifts.filter((sh) => sh.assignees.some((a) => a.userId === emp.connecteamUserId)).map((sh) => sh.startUnix);
  }
  const start = dayOneStart(emp.startDate, starts);
  if (start == null) return null;
  const at = start + DAY_ONE_DELAY_MIN * 60_000;
  return at > now ? at : null;
}

/** Personal email for the Google login when People has none: the hire's own Connecteam account email. */
async function personalEmailFromConnecteam(emp: Employee): Promise<string | null> {
  if (!emp.connecteamUserId) return null;
  const roster = await getUsersList().catch(() => []);
  const email = roster.find((u) => u.userId === emp.connecteamUserId)?.email?.trim().toLowerCase() ?? "";
  return email.includes("@") && !email.endsWith(`@${WORK_DOMAIN}`) ? email : null;
}

const OPEN = new Set(["pending", "manual_required", "failed", "in_progress", "blocked"]);

/** Approve and hand out the Chrome jobs for one person (all their open Chrome-run setup steps), or for the
 *  given task ids. Each step goes through the normal approval card + audit. Returns the jobs in run order,
 *  plus the steps that could not start and why. */
export async function startChromeRun(input: { employeeId: string; taskIds?: string[]; actor: string; origin: string; now?: boolean }): Promise<{
  jobs: ChromeJob[];
  skipped: { taskId: string; system: string; reason: string }[];
  runAt: number | null;
}> {
  let emp = getEmployee(input.employeeId);
  if (!emp) return { jobs: [], skipped: [], runAt: null };
  // The Google login needs a personal address; Gusto fills it on its next pull, Connecteam has it now.
  if (!emp.personalEmail) {
    const fromCt = await personalEmailFromConnecteam(emp);
    if (fromCt && fillEmployeeContact(emp.id, { personalEmail: fromCt }).length) {
      try {
        insertAudit({ actor: "People Lifecycle", action: "CONTACT_FILLED", entity: "employee", entityId: emp.id, before: null, after: { fields: ["personal_email"], detail: "Filled personal email from Connecteam." } });
      } catch {
        /* audit best effort */
      }
      emp = getEmployee(emp.id) ?? emp;
    }
  }
  // Day one: everything lands 10 minutes after the hire starts, unless asked to run now.
  const runAt = input.now ? null : await dayOneRunAt(emp, Date.now());
  const wanted = input.taskIds ? new Set(input.taskIds) : null;
  const tasks = listTasks(emp.id, "provision")
    .filter((t) => runsInChrome(t.adapterId) && OPEN.has(t.status) && (!wanted || wanted.has(t.id)))
    .filter((t) => !(t.status === "in_progress" && t.externalRef?.startsWith("invited:")))
    .sort((a, b) => ORDER.indexOf(a.adapterId) - ORDER.indexOf(b.adapterId));

  // The mailbox made in this run becomes the address the invites go to.
  // Only when that mailbox step can actually run, or the invites would go to an address that never exists.
  const mailboxTask = tasks.find((t) => t.adapterId === "squarespace_email");
  const mailboxRuns = mailboxTask ? !("blocked" in jobData("squarespace_email", emp, null)) : false;
  const planned = mailboxRuns ? `${mailboxUserName(emp)}@${WORK_DOMAIN}` : null;

  const jobs: ChromeJob[] = [];
  const skipped: { taskId: string; system: string; reason: string }[] = [];
  for (const t of tasks) {
    if (getAdapter(t.adapterId).mode() !== "automated") {
      skipped.push({ taskId: t.id, system: t.system, reason: "not set up to run in Chrome" });
      continue;
    }
    const d = jobData(t.adapterId, emp, planned);
    if ("blocked" in d) {
      updateTask(t.id, { status: "blocked", error: d.blocked });
      skipped.push({ taskId: t.id, system: t.system, reason: d.blocked });
      continue;
    }
    // Same approval card + audit as any automated step; the adapter marks it waiting for Chrome.
    if (t.status !== "in_progress") {
      if (t.status === "blocked") updateTask(t.id, { status: "pending", error: null });
      const r = await executeAutomatedTask(t.id, input.actor);
      if (!r.ok) {
        skipped.push({ taskId: t.id, system: t.system, reason: r.message });
        continue;
      }
    }
    const ep = PROVISION_ENDPOINTS[t.adapterId as ReplaySystem];
    if (runAt) updateTask(t.id, { externalRef: `${CHROME_SCHEDULED_PREFIX}${new Date(runAt).toISOString()}` });
    jobs.push({
      taskId: t.id,
      token: issue(t, input.actor, runAt),
      system: t.adapterId,
      systemName: t.system,
      employeeName: emp.displayName,
      resultUrl: `${input.origin.replace(/\/+$/, "")}/api/provision/result`,
      approval: ep?.approval ?? null,
      runAt,
      data: d.data,
    });
  }
  return { jobs, skipped, runAt: jobs.length ? runAt : null };
}

export type ChromeOutcome = "done" | "invited" | "already" | "failed" | "declined" | "by_hand";

export interface ChromeResult {
  taskId: string;
  token: string;
  outcome: ChromeOutcome;
  detail?: string;
  createdEmail?: string;
}

/** Systems whose invite is confirmed later by checking that the hire actually joined. */
const CONFIRM_LATER = new Set(["slack", "quo"]);

function keyMatches(stored: StoredJob | null, token: string): boolean {
  if (!stored || !token || Date.now() > stored.exp) return false;
  const a = Buffer.from(stored.hash, "hex");
  const b = Buffer.from(sha(token), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Record what the extension did. Rejects an unknown, expired or reused key. */
export function applyChromeResult(r: ChromeResult): { ok: boolean; message: string } {
  const task = getTask(r.taskId);
  if (!task || !runsInChrome(task.adapterId)) return { ok: false, message: "unknown task" };
  const stored = getJson<StoredJob | null>(KEY(task.id), null);
  if (!keyMatches(stored, r.token)) return { ok: false, message: "bad or expired key" };
  setJson(KEY(task.id), null); // one use
  const actor = stored!.actor;
  const detail = (r.detail ?? "").slice(0, 300);
  const now = new Date().toISOString();
  const emp = getEmployee(task.employeeId);
  const email = typeof r.createdEmail === "string" && r.createdEmail.includes("@") ? r.createdEmail.trim().toLowerCase() : null;

  let patch: Parameters<typeof updateTask>[1];
  switch (r.outcome) {
    case "done":
    case "already":
      if (task.adapterId === "squarespace_email" && email && emp) setEmployeeWorkEmail(emp.id, email);
      patch = { status: "completed", source: "automated", mode: "automated", externalRef: email ?? task.externalRef, error: null, actor, completedAt: now };
      break;
    case "invited": {
      const to = email ?? (emp?.workEmail || emp?.personalEmail || "");
      patch = CONFIRM_LATER.has(task.adapterId)
        ? { status: "in_progress", source: "automated", mode: "automated", externalRef: `invited:${to}`, error: null, actor }
        : { status: "completed", source: "automated", mode: "automated", externalRef: `invited:${to}`, error: null, actor, completedAt: now };
      break;
    }
    case "declined":
      patch = { status: "pending", externalRef: null, error: "Not approved in Chrome. Run it again when ready." };
      break;
    case "by_hand":
      patch = { status: "manual_required", externalRef: null, error: detail || "Could not finish in Chrome. Finish it in the open tab, then Mark complete." };
      break;
    default:
      patch = { status: "failed", externalRef: null, error: detail || "Failed in Chrome." };
  }
  const updated = updateTask(task.id, patch);
  try {
    insertAudit({
      actor,
      action: r.outcome === "done" || r.outcome === "already" || r.outcome === "invited" ? "ACCESS_GRANTED" : "ACCESS_SETUP_FAILED",
      entity: "employee",
      entityId: `${task.employeeId}:${task.adapterId}`,
      before: { status: task.status },
      after: { status: updated?.status, source: "chrome", outcome: r.outcome, detail },
    });
  } catch {
    /* audit best effort */
  }
  return { ok: true, message: `${task.system}: ${r.outcome}` };
}

// ── Joined yet? (People tick) ───────────────────────────────────────────────────────────────────────
async function slackHasMember(email: string): Promise<boolean | null> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`, { headers: { authorization: `Bearer ${token}` } });
    const j = (await res.json()) as { ok?: boolean; error?: string; user?: { deleted?: boolean } };
    if (j.ok) return !j.user?.deleted;
    return j.error === "users_not_found" ? false : null;
  } catch {
    return null;
  }
}

let quoUsersCache: { at: number; emails: Set<string> } | null = null;
async function quoHasMember(email: string): Promise<boolean | null> {
  const apiKey = loadSmsConfig("openphone").apiKey || process.env.OPENPHONE_API_KEY;
  if (!apiKey) return null;
  if (!quoUsersCache || Date.now() - quoUsersCache.at > 10 * 60_000) {
    try {
      const emails = new Set<string>();
      let pageToken: string | undefined;
      for (let i = 0; i < 10; i++) {
        const url = `https://api.openphone.com/v1/users?maxResults=50${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
        const res = await fetch(url, { headers: { authorization: apiKey } });
        if (!res.ok) return null;
        const j = (await res.json()) as { data?: { email?: string }[]; nextPageToken?: string };
        for (const u of j.data ?? []) if (u.email) emails.add(u.email.toLowerCase());
        pageToken = j.nextPageToken || undefined;
        if (!pageToken) break;
      }
      quoUsersCache = { at: Date.now(), emails };
    } catch {
      return null;
    }
  }
  return quoUsersCache.emails.has(email.toLowerCase());
}

/** Close Slack/Quo invites once the hire is actually in. Unknown (no key, API down) leaves them open. */
export async function confirmChromeInvites(open: LifecycleTask[], actor: string): Promise<number> {
  let n = 0;
  for (const t of open) {
    if (!CONFIRM_LATER.has(t.adapterId) || t.status !== "in_progress" || !t.externalRef?.startsWith("invited:")) continue;
    const email = t.externalRef.slice("invited:".length);
    if (!email) continue;
    const joined = t.adapterId === "slack" ? await slackHasMember(email) : await quoHasMember(email);
    if (joined !== true) continue;
    updateTask(t.id, { status: "completed", completedAt: new Date().toISOString(), actor: t.actor ?? actor, error: null });
    try {
      insertAudit({ actor, action: "ACCESS_CONFIRMED", entity: "employee", entityId: `${t.employeeId}:${t.adapterId}`, before: { status: "in_progress" }, after: { status: "completed", detail: `Joined ${t.system}.` } });
    } catch {
      /* audit best effort */
    }
    n++;
  }
  return n;
}

/** Test helper. */
export function _resetChromeJobCaches(): void {
  quoUsersCache = null;
}
