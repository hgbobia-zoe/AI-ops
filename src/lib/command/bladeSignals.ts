// Command Center blade signals — what the OTHER blades already know is wrong, folded into the hub's
// Needs attention list. The ops feed (opsOverview) covers risk / sales / finance / customer; this adds
// Payroll, Scheduling, Goodshuffle write-backs, Instawork, Post-Event and Radar.
//
// Rules: every item traces to a fact the owning blade already stores (no new detection logic, no
// thresholds of our own where the blade has one), reads are DB-only (nothing calls Connecteam, Gusto or
// Goodshuffle on a dashboard refresh), and one blade failing to read never hides the others.
// `buildBladeSignals` is pure and unit tested; `collectBladeSignals` is the thin live reader.

import type { Priority } from "@/lib/ops/manager";
import { shiftYmd } from "@/lib/dates";

/** One Needs attention row. `detail` keeps the ops feed's "reason → action" shape the page splits on. */
export interface HubItem {
  key: string;
  priority: Priority;
  score: number;
  title: string;
  detail: string;
  href: string;
  source: string; // owning blade label shown on the row ("Payroll", "Scheduling", …)
  financial: boolean; // hidden from roles that can't see money
}

export interface BladeFacts {
  today: string;
  now: number;
  /** Goodshuffle write-back queue alarm (aiorg/outboxHealth evaluateOutbox). */
  outbox?: { down: boolean; reasons: string[] } | null;
  /** Payroll exceptions queue (hr_exceptions) open count. */
  payrollOpenExceptions?: number | null;
  /** Gusto submits whose wire has not been seen and whose first reminder is due (payroll/wireReminder). */
  wiresPending?: { label: string; submittedAt: string }[];
  /** Active scheduling exceptions (OPEN/ACKNOWLEDGED shift_exceptions). */
  shiftExceptions?: { date: string | null; severity: string; title: string }[];
  /** Shifts flagged needs-review in the next 7 days (dates only). */
  needsReviewDates?: string[];
  /** Instawork probe state from pull_state (undefined until the first probe). */
  instawork?: { ok?: boolean; failingSince?: string | null } | null;
  /** Open Post-Event customer issues (postevent_issues not closed). */
  postEventOpenIssues?: number | null;
  /** HIGH-fit Radar events in their outreach window with no outreach started (seed rows excluded). */
  radarOutreach?: { name: string; date: string | null }[];
}

const PRIORITY_RANK: Record<Priority, number> = { critical: 3, high: 2, medium: 1, info: 0 };
// Blade signals score 0 so, inside a priority band, the ops feed's own ranking (scored by date and
// revenue, always > 0) keeps the lead; blade rows then follow in the order built below.
const BLADE_SCORE = 0;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const dayLabel = (ymd: string): string =>
  new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

function ago(iso: string, now: number): string {
  const m = Math.round((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(m) || m < 0) return "recently";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function item(p: Omit<HubItem, "score" | "financial"> & { financial?: boolean }): HubItem {
  return { ...p, score: BLADE_SCORE, financial: p.financial ?? false };
}

/** Turn each blade's stored facts into Needs attention rows. Pure. */
export function buildBladeSignals(f: BladeFacts): HubItem[] {
  const out: HubItem[] = [];
  const weekEnd = shiftYmd(f.today, 6);

  // Goodshuffle write-backs (customer emails, delivery photos, new projects) not landing.
  if (f.outbox?.down) {
    out.push(item({
      key: "blade:outbox", priority: "high", source: "Goodshuffle",
      title: "Goodshuffle write-backs are stuck",
      detail: `${f.outbox.reasons.join("; ")} → Open the office Goodshuffle tab`,
      href: "/admin/pull",
    }));
  }

  // Payroll: a submitted payroll with no wire yet (same timing as the Payroll blade's own reminder).
  for (const w of f.wiresPending ?? []) {
    out.push(item({
      key: `blade:wire:${w.label}`, priority: "high", source: "Payroll", financial: true,
      title: `Payroll wire not seen for ${w.label}`,
      detail: `Submitted in Gusto ${ago(w.submittedAt, f.now)}, no wire yet → Send the wire from Mercury`,
      href: "/payroll",
    }));
  }
  if (f.payrollOpenExceptions && f.payrollOpenExceptions > 0) {
    out.push(item({
      key: "blade:payroll-exceptions", priority: "medium", source: "Payroll", financial: true,
      title: `${plural(f.payrollOpenExceptions, "payroll exception")} open`,
      detail: "Open items in the payroll exceptions queue → Review in Payroll",
      href: "/payroll?tab=exceptions",
    }));
  }

  // Scheduling: active shift exceptions for today through the next 6 days, one row per severity.
  const week = (f.shiftExceptions ?? []).filter((x) => !x.date || (x.date >= f.today && x.date <= weekEnd));
  for (const [sev, priority, word] of [["RED", "high", "problem"], ["YELLOW", "medium", "warning"]] as const) {
    const xs = week.filter((x) => x.severity === sev).sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"));
    if (!xs.length) continue;
    const first = xs[0];
    out.push(item({
      key: `blade:shift-${sev.toLowerCase()}`, priority, source: "Scheduling",
      title: `${plural(xs.length, `shift ${word}`)} this week`,
      detail: `${first.title}${first.date ? ` (${dayLabel(first.date)})` : ""}${xs.length > 1 ? ` and ${xs.length - 1} more` : ""} → Fix in Scheduling`,
      href: first.date ? `/scheduling?date=${first.date}` : "/scheduling",
    }));
  }
  const review = (f.needsReviewDates ?? []).filter((d) => d >= f.today && d <= weekEnd).sort();
  if (review.length) {
    out.push(item({
      key: "blade:needs-review", priority: "medium", source: "Scheduling",
      title: `${plural(review.length, "shift needs", "shifts need")} review`,
      detail: `Connecteam and Zoe disagree, first on ${dayLabel(review[0])} → Resolve in Scheduling`,
      href: `/scheduling?date=${review[0]}`,
    }));
  }

  // Instawork: the blade's own probe says the sync is failing.
  if (f.instawork && f.instawork.ok === false) {
    out.push(item({
      key: "blade:instawork", priority: "medium", source: "Instawork",
      title: "Instawork sync is failing",
      detail: `${f.instawork.failingSince ? `Failing since ${ago(f.instawork.failingSince, f.now)}` : "Last check failed"} → Sign in to Instawork in the office Chrome`,
      href: "/admin/health",
    }));
  }

  // Post-Event: open customer issues are service recovery and come first in that blade.
  if (f.postEventOpenIssues && f.postEventOpenIssues > 0) {
    out.push(item({
      key: "blade:postevent-issues", priority: "high", source: "Post-Event",
      title: `${plural(f.postEventOpenIssues, "open customer issue")}`,
      detail: "Service recovery comes before review requests → Work the issues",
      href: "/postevent/issues",
    }));
  }

  // Radar: an opportunity, not a problem, so it ranks lowest.
  const radar = f.radarOutreach ?? [];
  if (radar.length) {
    out.push(item({
      key: "blade:radar-outreach", priority: "info", source: "Radar",
      title: `${plural(radar.length, "high-fit event")} in the outreach window`,
      detail: `${radar[0].name}${radar.length > 1 ? ` and ${radar.length - 1} more` : ""}, no outreach started → Open Radar`,
      href: "/radar",
    }));
  }

  return out;
}

/** Merge the ops feed with the blade signals: highest priority first, then score. Pure. */
export function mergeAttention(ops: HubItem[], blades: HubItem[]): HubItem[] {
  return [...ops, ...blades].sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || b.score - a.score);
}
