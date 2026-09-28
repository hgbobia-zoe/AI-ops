// Pipeline Status — the on-demand executive summary of every OPEN quote. FACTS ONLY, all figures
// COMPUTED (never fabricated, never AI-invented): for each open lead we resolve the effective board
// stage + customer state (reusing the Sales OS aggregation) and read its money straight from bookings
// (DOLLARS — the ingest already divided GS cents by 100), then fold in the unified activity timeline to
// surface the two numbers that reveal neglect: the last activity across ALL channels, and the last time
// a rep actually reached out. Where a fact doesn't exist we say so (null → the UI renders "no record").
//
// "Open" is exactly getOpenLeads' definition (unsigned, not lost/cancelled/dead, event null-or-future) —
// the single source of truth for the pipeline, unchanged here.

import { getOpenLeads, getAllCustomerStates, type BookingView } from "@/lib/db/repo";
import { todayInOpsTz } from "@/lib/dates";
import { salesLeadCards } from "./board";
import { resolveDeterministic, fromStored } from "./stateService";
import { STATE_LABEL } from "./state";
import { STATUS_LABEL, type LeadStatus } from "./boardTypes";
import { buildLeadTimeline, timelineLastActivity, timelineLastOutbound, type TimelineEntry } from "./timeline";

export interface TouchInfo {
  at: string; // ISO
  channel: TimelineEntry["channel"];
  direction: TimelineEntry["direction"];
  title: string;
  daysAgo: number;
}

export interface PipelineStatusRow {
  id: string;
  clientName: string; // "" when GS had no client name — UI shows "no record"
  eventName: string;
  boardStatus: LeadStatus;
  boardStatusLabel: string;
  stateLabel: string;
  value: number | null; // grand_total (dollars); null = no record
  amountDue: number | null; // amount_due (dollars); null = no record
  eventDate: string | null; // YYYY-MM-DD; null = undated
  daysToEvent: number | null; // null = undated
  quoteSentAt: string | null; // ISO precise send; null = no record
  quoteSentDate: string | null; // YYYY-MM-DD fallback; null = no record
  quoteOpenedAt: string | null; // ISO; null = never opened / no record
  lastActivity: TouchInfo | null; // newest dated touch across all channels; null = no record
  lastOutbound: TouchInfo | null; // newest rep outreach (text/call/email/quote sent); null = rep never reached out
  daysSinceActivity: number | null;
  daysSinceOutbound: number | null; // null = rep never reached out
  awaitingReply: boolean; // last activity was inbound (customer is waiting on us)
  openedNoFollowup: boolean; // client opened the quote and no rep outreach happened after
  neglected7: boolean; // no rep outreach in > 7 days (incl. never)
  neglected14: boolean; // no rep outreach in > 14 days (incl. never)
  timeline: TimelineEntry[];
}

export interface ExecSummary {
  generatedAt: string; // ISO — when this rollup was computed (it is on-demand)
  today: string; // YYYY-MM-DD ops day
  openCount: number;
  totalPotential: number | null; // sum of grand_total across priced open quotes ($); null when none priced
  pricedCount: number; // how many open quotes carry a price (so totalPotential is honest)
  totalAmountDue: number | null; // sum of amount_due across open quotes with a due figure ($)
  amountDueCount: number;
  untouched7: number; // rep hasn't reached out in > 7d (incl. never)
  untouched14: number;
  neverTouched: number; // no rep outreach ever recorded
  openedNoFollowup: number; // client opened the quote, no follow-up
  awaitingReply: number; // customer's last message is unanswered
  oldestNeglected: { id: string; clientName: string; eventName: string; daysSinceOutbound: number | null } | null;
}

export interface PipelineStatus {
  summary: ExecSummary;
  rows: PipelineStatusRow[];
}

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

function daysSinceIso(iso: string | null, today: string): number | null {
  if (!iso) return null;
  const t = Date.parse(iso.length > 10 ? iso : `${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  const now = Date.parse(`${today}T00:00:00Z`);
  return Math.max(0, Math.round((now - t) / 86_400_000));
}

function touchOf(e: TimelineEntry | null, today: string): TouchInfo | null {
  if (!e || !e.at) return null;
  return { at: e.at, channel: e.channel, direction: e.direction, title: e.title, daysAgo: daysSinceIso(e.at, today) ?? 0 };
}

/** Build the full pipeline-status view: one row per open quote + the deterministic executive rollup.
 *  Everything is computed from stored facts. */
export function buildPipelineStatus(today: string = todayInOpsTz()): PipelineStatus {
  const open = getOpenLeads(today);
  const states = getAllCustomerStates();
  // Effective board status (manual override else derived) — reuse the Sales OS board computation.
  const statusById = new Map<string, LeadStatus>();
  for (const c of salesLeadCards()) statusById.set(c.id, c.status);

  const rows: PipelineStatusRow[] = open.map((b: BookingView) => {
    const timeline = buildLeadTimeline(b.bookingId);
    const lastActivity = timelineLastActivity(timeline);
    const lastOutbound = timelineLastOutbound(timeline);
    const daysSinceOutbound = daysSinceIso(lastOutbound?.at ?? null, today);

    const stored = states.get(b.bookingId);
    const state = stored ? fromStored(stored) : resolveDeterministic(b);

    const boardStatus = statusById.get(b.bookingId) ?? (b.signed ? "signed" : "quote_sent");

    // Opened-with-no-follow-up: the client opened the quote and no rep outreach happened afterward.
    const openedT = b.quoteOpenedAt ? Date.parse(b.quoteOpenedAt) : null;
    const lastOutT = lastOutbound?.at ? Date.parse(lastOutbound.at) : null;
    const openedNoFollowup = openedT != null && (lastOutT == null || lastOutT <= openedT);

    // "Awaiting our reply" means the customer actually reached out (text/call/email) and we're the last
    // ones who owe a response — a passive quote-open doesn't count.
    const awaitingReply = lastActivity != null && lastActivity.direction === "in" && lastActivity.channel !== "quote";

    return {
      id: b.bookingId,
      clientName: b.clientName,
      eventName: b.eventName,
      boardStatus,
      boardStatusLabel: STATUS_LABEL[boardStatus],
      stateLabel: STATE_LABEL[state.state],
      value: b.grandTotal,
      amountDue: b.amountDue,
      eventDate: b.eventDate,
      daysToEvent: b.eventDate ? daysBetween(today, b.eventDate) : null,
      quoteSentAt: b.quoteSentAt ?? null,
      quoteSentDate: b.quoteSentDate,
      quoteOpenedAt: b.quoteOpenedAt ?? null,
      lastActivity: touchOf(lastActivity, today),
      lastOutbound: touchOf(lastOutbound, today),
      daysSinceActivity: daysSinceIso(lastActivity?.at ?? null, today),
      daysSinceOutbound,
      awaitingReply,
      openedNoFollowup,
      neglected7: daysSinceOutbound == null || daysSinceOutbound > 7,
      neglected14: daysSinceOutbound == null || daysSinceOutbound > 14,
      timeline,
    };
  });

  // Deterministic rollup — all sums null-safe (a missing figure is skipped, never counted as 0).
  let totalPotential: number | null = null;
  let pricedCount = 0;
  let totalAmountDue: number | null = null;
  let amountDueCount = 0;
  let untouched7 = 0;
  let untouched14 = 0;
  let neverTouched = 0;
  let openedNoFollowup = 0;
  let awaitingReply = 0;
  let oldest: PipelineStatusRow | null = null;

  for (const r of rows) {
    if (r.value != null) {
      totalPotential = (totalPotential ?? 0) + r.value;
      pricedCount++;
    }
    if (r.amountDue != null) {
      totalAmountDue = (totalAmountDue ?? 0) + r.amountDue;
      amountDueCount++;
    }
    if (r.neglected7) untouched7++;
    if (r.neglected14) untouched14++;
    if (r.daysSinceOutbound == null) neverTouched++;
    if (r.openedNoFollowup) openedNoFollowup++;
    if (r.awaitingReply) awaitingReply++;
    // Oldest-neglected: prefer a never-touched lead, else the largest days-since-outbound.
    if (oldest == null) oldest = r;
    else {
      const ord = (x: PipelineStatusRow): number => (x.daysSinceOutbound == null ? Number.POSITIVE_INFINITY : x.daysSinceOutbound);
      if (ord(r) > ord(oldest)) oldest = r;
    }
  }

  const summary: ExecSummary = {
    generatedAt: new Date().toISOString(),
    today,
    openCount: rows.length,
    totalPotential,
    pricedCount,
    totalAmountDue,
    amountDueCount,
    untouched7,
    untouched14,
    neverTouched,
    openedNoFollowup,
    awaitingReply,
    oldestNeglected: oldest ? { id: oldest.id, clientName: oldest.clientName, eventName: oldest.eventName, daysSinceOutbound: oldest.daysSinceOutbound } : null,
  };

  return { summary, rows };
}
