// Automation register (MVP8): the honest list of what the platform does ON ITS OWN today.
//
// It reads what already records each automation; it adds no new tracking and runs nothing:
//   • scheduled jobs: the runtime registry + import ledger (runtimeStatus, the same data as /admin)
//   • Goodshuffle write-backs: the gs_outbox queue (waiting, landed, needs a person)
//   • AI approvals: ai_approvals (waiting on a person, decided in the last 7 days)
//   • on/off switches: the flagOn() kill switches (src/lib/flags.ts), read from env
// The pure helpers (jobArea, summarizeJobs, groupJobs, switchStates, summarizeApprovals) are unit tested.

import { getDb } from "@/lib/db";
import { runtimeStatus, type JobStatus, type JobState } from "@/lib/runtime/jobs";
import { liveOutboxSummary, type OutboxSummary } from "@/lib/aiorg/outboxHealth";
import { flagOn } from "@/lib/flags";

// ── Scheduled jobs ─────────────────────────────────────────────────────────────────────────────────

export type JobArea = "Sales" | "Crew & scheduling" | "Dispatch" | "Payroll" | "Monitoring" | "Marketing" | "Other";

export const AREA_ORDER: JobArea[] = ["Sales", "Crew & scheduling", "Dispatch", "Payroll", "Monitoring", "Marketing", "Other"];

// Job key (runtime/jobs.ts) → the part of the business it serves. A key missing here shows as "Other",
// so a job another session adds still appears, just ungrouped.
const JOB_AREA: Record<string, JobArea> = {
  "sales-ai": "Sales",
  "esign-cutoff": "Sales",
  "lead-slack-reply": "Sales",
  "openphone-message-sync": "Sales",
  "sales-action-items": "Sales",
  "morning-outreach": "Sales",
  "postevent-digest": "Sales", // Post-Event sits under Sales in the nav
  "opportunity-radar": "Sales", // business development discovery
  instawork: "Crew & scheduling",
  connecteam: "Crew & scheduling",
  "connecteam-sync": "Crew & scheduling",
  "connecteam-route-sync": "Crew & scheduling",
  "shift-lifecycle": "Crew & scheduling",
  "route-precheck": "Crew & scheduling",
  "prep-opportunity": "Crew & scheduling",
  "truck-crew-guard": "Crew & scheduling",
  "worker-packets": "Crew & scheduling",
  "people-lifecycle": "Crew & scheduling",
  route: "Dispatch",
  "route-handoff": "Dispatch",
  "etalink-premint": "Dispatch",
  "gps-visit": "Dispatch",
  "payroll-sync": "Payroll",
  "payroll-precheck": "Payroll",
  "payroll-wire-reminder": "Payroll",
  "viktor-agent": "Monitoring",
  "outbox-health": "Monitoring",
  "self-audit": "Monitoring",
  "exception-resolution": "Monitoring",
  "website-uptime": "Monitoring",
  ubersuggest: "Marketing",
  "marketing-lead-log": "Marketing",
};

/** Jobs whose last-run detail can carry dollar amounts; hidden from viewers who can't see money. */
export const FINANCIAL_JOB_KEYS: ReadonlySet<string> = new Set(["payroll-sync", "payroll-precheck", "payroll-wire-reminder", "gps-visit"]);

export function jobArea(key: string): JobArea {
  return JOB_AREA[key] ?? "Other";
}

export interface JobCounts {
  total: number;
  running: number; // ok: ran recently and succeeded
  failing: number; // last run errored
  stale: number; // configured but has not run in over a day
  notSetUp: number; // missing its credential, so it is skipped
  neverRun: number; // configured but no run recorded yet
  browser: number; // needs the logged-in office browser (Goodshuffle)
}

/** PURE. Count jobs by state. */
export function summarizeJobs(jobs: Pick<JobStatus, "state">[]): JobCounts {
  const c: JobCounts = { total: jobs.length, running: 0, failing: 0, stale: 0, notSetUp: 0, neverRun: 0, browser: 0 };
  const field: Record<JobState, keyof JobCounts> = {
    ok: "running",
    error: "failing",
    stale: "stale",
    not_configured: "notSetUp",
    never: "neverRun",
    browser_pending: "browser",
  };
  for (const j of jobs) c[field[j.state]]++;
  return c;
}

const STATE_RANK: Record<JobState, number> = { error: 0, stale: 1, never: 2, browser_pending: 3, ok: 4, not_configured: 5 };

/** PURE. Group jobs by area in AREA_ORDER; inside an area, problems first, then by name. Empty areas dropped. */
export function groupJobs<T extends Pick<JobStatus, "key" | "label" | "state">>(jobs: T[]): { area: JobArea; jobs: T[] }[] {
  const by = new Map<JobArea, T[]>();
  for (const j of jobs) {
    const a = jobArea(j.key);
    const list = by.get(a) ?? [];
    list.push(j);
    by.set(a, list);
  }
  return AREA_ORDER.filter((a) => by.has(a)).map((area) => ({
    area,
    jobs: [...by.get(area)!].sort((x, y) => STATE_RANK[x.state] - STATE_RANK[y.state] || x.label.localeCompare(y.label)),
  }));
}

// ── On/off switches ────────────────────────────────────────────────────────────────────────────────

export interface SwitchDef {
  env: string;
  label: string;
  controls: string;
}

// Every shipped kill switch read through flagOn(). Each is ON unless its env var is set to false.
export const SWITCHES: SwitchDef[] = [
  { env: "SMS_SEND_ENABLED", label: "Outgoing texts", controls: "Sales texts, shift pass texts and worker debrief texts. Off stops all three." },
  { env: "EMAIL_SEND_ENABLED", label: "Client emails", controls: "Emails sent into Goodshuffle client threads from Sales and from approved AI drafts." },
  { env: "WEB_INTAKE_ENABLED", label: "Lead intake", controls: "Turning website, Yelp and Google leads into Goodshuffle projects. Off still records the lead." },
  { env: "WEB_INTAKE_ACK_EMAIL", label: "Lead welcome email", controls: "The welcome email new leads get from inside their Goodshuffle project." },
  { env: "WEB_LEAD_SMS", label: "Google lead welcome text", controls: "The welcome text to Google leads (website and Yelp leads are answered by their own channel)." },
  { env: "SHIFT_COMMS_ENABLED", label: "Crew shift texts", controls: "Texts to crew about their shifts." },
  { env: "AUTO_PACKET_ENABLED", label: "Automatic debriefs", controls: "Worker debriefs sent on their own 2 hours before a shift. Also needs crew shift texts and outgoing texts on." },
  { env: "SALES_AI_ENABLED", label: "Sales AI", controls: "The scheduled Sales AI pass for Jessie's team." },
  { env: "GS_NOTE_SYNC_ENABLED", label: "Notes to Goodshuffle", controls: "Copying sales texts and calls into the Goodshuffle project notes." },
  { env: "POSTEVENT_DAILY_DIGEST", label: "Post-Event morning nudge", controls: "The daily Slack card listing the customers who need a follow up, an issue resolved or a review invite." },
  { env: "CALL_SENTIMENT_LLM", label: "AI call tone", controls: "AI reads call tone for customer alerts. Off falls back to the free rule based check." },
];

export interface SwitchState extends SwitchDef {
  on: boolean;
}

/** PURE given `isOn`. Defaults to the real flagOn. */
export function switchStates(isOn: (env: string) => boolean = flagOn, defs: SwitchDef[] = SWITCHES): SwitchState[] {
  return defs.map((d) => ({ ...d, on: isOn(d.env) }));
}

// ── Goodshuffle write-backs ────────────────────────────────────────────────────────────────────────

const OP_LABEL: Record<string, string> = {
  photo_upload: "Delivery photo uploaded",
  note_append: "Note added to a project",
  add_team_member: "Team member added to a project",
  set_delivery_fee: "Delivery fee set",
  email_send: "Email sent to a client",
  email_template: "Template email sent (welcome)",
  create_gs_task: "Task created in Goodshuffle",
  provision_user: "Goodshuffle user added",
  revoke_user: "Goodshuffle user removed",
  create_project: "Project created from a lead",
  remove_waypoint: "Stop removed from a route",
  disable_esignature: "Online signing turned off",
  mark_lost: "Project marked lost and archived",
};

export function opLabel(op: string): string {
  return OP_LABEL[op] ?? op.replace(/_/g, " ");
}

export interface LandedOp {
  op: string;
  label: string;
  count: number;
}

export interface WriteBacks {
  summary: OutboxSummary;
  landed7d: LandedOp[];
  landedTotal: number;
}

const WEEK_MS = 7 * 86_400_000;

function liveWriteBacks(now: number): WriteBacks {
  const since = new Date(now - WEEK_MS).toISOString();
  const rows = getDb()
    .prepare("SELECT op, COUNT(*) AS n FROM gs_outbox WHERE status = 'done' AND updated_at >= ? GROUP BY op ORDER BY n DESC")
    .all(since) as { op: string; n: number }[];
  const landed7d = rows.map((r) => ({ op: r.op, label: opLabel(r.op), count: Number(r.n) }));
  return { summary: liveOutboxSummary(now), landed7d, landedTotal: landed7d.reduce((s, r) => s + r.count, 0) };
}

// ── AI approvals ───────────────────────────────────────────────────────────────────────────────────

export interface ApprovalCounts {
  waiting: number; // pending, edited or more info requested: a person still has to decide
  executed7d: number; // approved and handed to the outbox
  held7d: number; // approved but held (its send switch is off, or it has no automatic path)
  rejected7d: number;
  failed7d: number;
}

const WAITING = new Set(["pending", "edited", "info_requested"]);

/** PURE. Count approvals from their status + decided time. */
export function summarizeApprovals(rows: { status: string; decided_at: string | null }[], now: number): ApprovalCounts {
  const c: ApprovalCounts = { waiting: 0, executed7d: 0, held7d: 0, rejected7d: 0, failed7d: 0 };
  for (const r of rows) {
    if (WAITING.has(r.status)) {
      c.waiting++;
      continue;
    }
    const t = r.decided_at ? Date.parse(r.decided_at) : NaN;
    if (!Number.isFinite(t) || now - t > WEEK_MS) continue;
    if (r.status === "executed") c.executed7d++;
    else if (r.status === "approved") c.held7d++;
    else if (r.status === "rejected") c.rejected7d++;
    else if (r.status === "failed") c.failed7d++;
  }
  return c;
}

function liveApprovals(now: number): ApprovalCounts {
  const since = new Date(now - WEEK_MS).toISOString();
  const rows = getDb()
    .prepare("SELECT status, decided_at FROM ai_approvals WHERE status IN ('pending','edited','info_requested') OR decided_at >= ?")
    .all(since) as { status: string; decided_at: string | null }[];
  return summarizeApprovals(rows, now);
}

// ── The register ───────────────────────────────────────────────────────────────────────────────────

export interface RegisterJob extends JobStatus {
  area: JobArea;
}

export interface AutomationRegister {
  jobs: RegisterJob[];
  jobCounts: JobCounts;
  writeBacks: WriteBacks;
  approvals: ApprovalCounts;
  switches: SwitchState[];
}

/** Everything that runs on its own, read live. `showMoney` false hides financial job details. */
export function automationRegister({ showMoney }: { showMoney: boolean }, now: number = Date.now()): AutomationRegister {
  const jobs: RegisterJob[] = runtimeStatus().map((j) => ({
    ...j,
    area: jobArea(j.key),
    lastDetail: !showMoney && FINANCIAL_JOB_KEYS.has(j.key) ? null : j.lastDetail,
  }));
  return {
    jobs,
    jobCounts: summarizeJobs(jobs),
    writeBacks: liveWriteBacks(now),
    approvals: liveApprovals(now),
    switches: switchStates(),
  };
}
