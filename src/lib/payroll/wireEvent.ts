// Mercury "wire out to Gusto" event — the "wire sent" seam in the owner's end-to-end payroll automation.
// A Zapier workflow (Mercury New Transaction trigger, then a filter) POSTs the matching transaction to
// /api/payroll/wire-detected; this module does the deterministic work behind that endpoint:
//   1. normalize the untrusted/partial Mercury body (FACTS ONLY, coerce safely),
//   2. classify it as a Gusto payroll wire (outgoing + a CONFIGURABLE counterparty pattern),
//   3. best-effort correlate |amount| to the current/last payroll period's estimate (never fabricate),
//   4. persist the event keyed by transactionId (deduped, idempotent) — the record is ALSO the seam for the
//      FUTURE "confirm the wire in Gusto" step, so it carries everything that step will need.
// The Slack alert itself is posted by the endpoint via the shared payroll Slack path (payroll/slack.ts);
// nothing here talks to Slack. Message strings run through humanize() so they follow the house COMMS_STYLE
// (no dashes, no emoji). Persisted in the settings KV, like the other payroll state (gustoPushState etc.).

import { getJson, setJson } from "@/lib/kv";
import { getPayrollConfig, type PayrollConfig } from "./config";
import { namedPeriod } from "./period";
import { payrollReview } from "./review";
import { humanize } from "@/lib/salesos/outreach";
import type { BotCard } from "@/lib/notify/aiBots";
import type { PayPeriod } from "./types";

// ── Normalize the Mercury transaction (untrusted / possibly partial) ──────────────────────────────────
export interface MercuryTxnInput {
  amount?: unknown; // NEGATIVE = money going out
  status?: unknown; // "pending" | "sent" | "failed" | "posted"
  counterpartyName?: unknown; // e.g. "ZenPayroll", "Gusto", "Instawork.com"
  bankDescription?: unknown;
  kind?: unknown; // e.g. "debitCardTransaction" | "internalTransfer" | a wire kind
  createdAt?: unknown; // ISO
  estimatedDeliveryDate?: unknown; // ISO
  dashboardLink?: unknown; // Mercury URL
  transactionId?: unknown; // stable id
}

export interface NormalizedTxn {
  amount: number | null;
  status: string | null;
  counterpartyName: string | null;
  bankDescription: string | null;
  kind: string | null;
  createdAt: string | null;
  estimatedDeliveryDate: string | null;
  dashboardLink: string | null;
  transactionId: string | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Coerce an arbitrary POST body into a NormalizedTxn. Never throws; unknown fields become null. */
export function normalizeMercuryTxn(raw: unknown): NormalizedTxn {
  const b = (raw ?? {}) as MercuryTxnInput;
  return {
    amount: num(b.amount),
    status: str(b.status)?.toLowerCase() ?? null,
    counterpartyName: str(b.counterpartyName),
    bankDescription: str(b.bankDescription),
    kind: str(b.kind),
    createdAt: str(b.createdAt),
    estimatedDeliveryDate: str(b.estimatedDeliveryDate),
    dashboardLink: str(b.dashboardLink),
    transactionId: str(b.transactionId),
  };
}

// ── Classification ────────────────────────────────────────────────────────────────────────────────────
// A Gusto payroll wire = money going OUT (amount < 0) AND the counterparty / bank description matches a
// configurable pattern. Default is Gusto's banking entity names. Tunable WITHOUT a deploy via the env var
// PAYROLL_WIRE_MATCH_PATTERN or the payroll Settings `wireMatchPattern`, so the exact counterparty text can
// be corrected once seen in production. `kind` is intentionally NOT gated on: the counterparty match is the
// robust signal and the spec defines the rule as amount + counterparty/description.
export const DEFAULT_WIRE_MATCH_PATTERN = "gusto|zenpayroll";

/** The raw regex source in effect: env override, then Settings, then the default. */
export function wireMatchSource(cfg: PayrollConfig = getPayrollConfig()): string {
  const env = process.env.PAYROLL_WIRE_MATCH_PATTERN?.trim();
  return env || cfg.wireMatchPattern?.trim() || DEFAULT_WIRE_MATCH_PATTERN;
}

/** The compiled, case-insensitive matcher. Falls back to the default if the configured source is invalid. */
export function wireMatchRegex(cfg?: PayrollConfig): RegExp {
  const src = wireMatchSource(cfg);
  try {
    return new RegExp(src, "i");
  } catch {
    return new RegExp(DEFAULT_WIRE_MATCH_PATTERN, "i");
  }
}

export interface WireClassification {
  isPayrollWire: boolean;
  outgoing: boolean;
  matched: boolean;
  amountAbs: number | null;
  reason: string;
}

export function classifyWire(txn: NormalizedTxn, cfg?: PayrollConfig): WireClassification {
  const re = wireMatchRegex(cfg);
  const outgoing = txn.amount != null && txn.amount < 0;
  const haystack = `${txn.counterpartyName ?? ""} ${txn.bankDescription ?? ""}`.trim();
  const matched = haystack.length > 0 && re.test(haystack);
  const amountAbs = txn.amount != null ? Math.abs(txn.amount) : null;
  const isPayrollWire = outgoing && matched;
  const reason = isPayrollWire
    ? "payroll wire"
    : !outgoing
      ? "not an outgoing debit"
      : "counterparty/description did not match the payroll pattern";
  return { isPayrollWire, outgoing, matched, amountAbs, reason };
}

// ── Best-effort period correlation (RULES CALCULATE — never fabricated) ───────────────────────────────
const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface PeriodTotalCandidate {
  period: PayPeriod;
  expectedTotal: number; // dollars
  source: string;
}

export interface WirePeriodMatch {
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  expectedTotal: number;
  source: string;
  deltaPct: number; // how far the wire was from the expected total
}

/** Default tolerance: |amount - expected| / expected within this % counts as a match. Tunable via env. */
export function wireTolerancePct(): number {
  const n = Number(process.env.PAYROLL_WIRE_MATCH_TOLERANCE_PCT);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : 5;
}

/** PURE: pick the closest candidate period whose expected total is within tolerance of the wire. Null when
 *  nothing is close enough — the caller then posts an "unconfirmed period" alert rather than guessing. */
export function matchWireAmount(
  amountAbs: number | null,
  candidates: PeriodTotalCandidate[],
  tolerancePct: number = wireTolerancePct(),
): WirePeriodMatch | null {
  if (amountAbs == null || !Number.isFinite(amountAbs) || amountAbs <= 0) return null;
  let best: WirePeriodMatch | null = null;
  for (const c of candidates) {
    if (!(c.expectedTotal > 0)) continue;
    const deltaPct = (Math.abs(amountAbs - c.expectedTotal) / c.expectedTotal) * 100;
    if (deltaPct <= tolerancePct && (best == null || deltaPct < best.deltaPct)) {
      best = {
        periodStart: c.period.start,
        periodEnd: c.period.end,
        periodLabel: c.period.label,
        expectedTotal: round2(c.expectedTotal),
        source: c.source,
        deltaPct: round2(deltaPct),
      };
    }
  }
  return best;
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Build the candidate period totals, best-effort. Reuses the payroll Review engine (ready + review
 *  estimate) for the current and previous periods. Each lookup is wrapped: a Connecteam/Gusto hiccup yields
 *  no candidate for that period rather than throwing, so correlation can only ADD confidence, never block
 *  the alert. Returns [] when nothing is computable. */
export async function payrollPeriodCandidates(today: string = todayYmd()): Promise<PeriodTotalCandidate[]> {
  const out: PeriodTotalCandidate[] = [];
  for (const which of ["current", "previous"] as const) {
    try {
      const period = namedPeriod(today, which);
      const review = await payrollReview(period);
      const total = (review.estReadyPayroll ?? 0) + (review.estReviewPayroll ?? 0);
      if (total > 0) out.push({ period, expectedTotal: round2(total), source: `payroll review estimate (${which} period)` });
    } catch {
      /* best-effort: a period we cannot compute simply contributes no candidate */
    }
  }
  return out;
}

// ── Persistence + idempotency (KV-backed, keyed by transactionId) ─────────────────────────────────────
// Stored as a { [transactionId]: WireEventRecord } map in the settings KV (same store as gustoPushState).
// transactionId is the dedup key: Zapier retries and Mercury re-delivering the same transaction (e.g. a
// pending → sent status change) land on the SAME record. We post ONCE on the first qualifying event, update
// the record on later ones WITHOUT re-posting, and post exactly one extra concise update if the status later
// becomes "failed". This record is the seam the future "confirm the wire in Gusto" step reads.
const KEY = "payroll.wireEvents";
const MAX_RECORDS = 500;

export interface WireEventRecord {
  transactionId: string;
  amount: number | null; // as received (negative for an outgoing wire)
  amountAbs: number | null;
  counterpartyName: string | null;
  bankDescription: string | null;
  kind: string | null;
  status: string | null; // latest status seen
  createdAt: string | null;
  estimatedDeliveryDate: string | null;
  dashboardLink: string | null;
  matchedPeriod: WirePeriodMatch | null; // null = period unconfirmed
  postedToSlack: boolean;
  postedAt: string | null;
  failureNotified: boolean; // whether the one-time "failed" update was posted
  statusHistory: string[]; // statuses observed, in order
  firstSeenAt: string;
  updatedAt: string;
  // Gusto RECEIPT confirmation — set when the inbound "Gusto received your wire" email is matched to this
  // wire (via /api/payroll/gusto-wire-received). Closes the loop: the wire we sent is confirmed funded.
  receiptConfirmed?: boolean;
  receiptConfirmedAt?: string | null;
  receiptAmountAbs?: number | null;
  receiptDate?: string | null; // yyyy-mm-dd as stated by Gusto, when parseable
}

type WireStore = Record<string, WireEventRecord>;

export function readWireEvent(transactionId: string): WireEventRecord | null {
  const store = getJson<WireStore>(KEY, {});
  return store[transactionId] ?? null;
}

/** Most-recent-first, for the future confirm step / any UI. */
export function listWireEvents(limit = 100): WireEventRecord[] {
  const store = getJson<WireStore>(KEY, {});
  return Object.values(store)
    .sort((a, b) => (a.firstSeenAt < b.firstSeenAt ? 1 : -1))
    .slice(0, Math.max(0, limit));
}

export function upsertWireEvent(rec: WireEventRecord): void {
  const store = getJson<WireStore>(KEY, {});
  store[rec.transactionId] = rec;
  // Cap growth: keep the most recent MAX_RECORDS by firstSeenAt.
  const ids = Object.values(store).sort((a, b) => (a.firstSeenAt < b.firstSeenAt ? 1 : -1));
  if (ids.length > MAX_RECORDS) {
    const trimmed: WireStore = {};
    for (const r of ids.slice(0, MAX_RECORDS)) trimmed[r.transactionId] = r;
    setJson(KEY, trimmed);
    return;
  }
  setJson(KEY, store);
}

// ── Gusto receipt correlation + idempotency (the inbound "Gusto received your wire" email) ────────────
/** The most-recent wire whose |amount| is within tolerance and whose Gusto receipt is NOT yet confirmed.
 *  Used to tie the inbound "Gusto received your wire" email to the wire we actually sent. Null = no match
 *  (the receipt is still posted, just without a linked Mercury wire). */
export function findUnconfirmedWireByAmount(amountAbs: number | null, tolerancePct = 2): WireEventRecord | null {
  if (amountAbs == null || !Number.isFinite(amountAbs) || amountAbs <= 0) return null;
  let best: { rec: WireEventRecord; delta: number } | null = null;
  for (const rec of listWireEvents(100)) {
    if (rec.receiptConfirmed) continue;
    if (rec.amountAbs == null || !(rec.amountAbs > 0)) continue;
    const delta = (Math.abs(amountAbs - rec.amountAbs) / rec.amountAbs) * 100;
    if (delta <= tolerancePct && (best == null || delta < best.delta)) best = { rec, delta };
  }
  return best?.rec ?? null;
}

/** Mark a stored wire as confirmed-received by Gusto. Idempotent: returns the updated record, or null when
 *  the transactionId is unknown. */
export function markWireReceiptConfirmed(
  transactionId: string,
  info: { amountAbs: number | null; date: string | null; at: string },
): WireEventRecord | null {
  const rec = readWireEvent(transactionId);
  if (!rec) return null;
  rec.receiptConfirmed = true;
  rec.receiptConfirmedAt = info.at;
  rec.receiptAmountAbs = info.amountAbs;
  rec.receiptDate = info.date;
  rec.updatedAt = info.at;
  upsertWireEvent(rec);
  return rec;
}

// Receipt-email dedup lives in its own key because a receipt can arrive with NO matching Mercury wire on
// file; we still want to post exactly once. Keyed by a stable receipt key (Gmail message id, else amount+date).
const RECEIPT_POSTED_KEY = "payroll.wireReceiptsPosted";
export function wasReceiptPosted(key: string): boolean {
  return Boolean(getJson<Record<string, string>>(RECEIPT_POSTED_KEY, {})[key]);
}
export function markReceiptPosted(key: string, at: string): void {
  const store = getJson<Record<string, string>>(RECEIPT_POSTED_KEY, {});
  store[key] = at;
  setJson(RECEIPT_POSTED_KEY, store);
}

/** Merge a freshly-received transaction into (or create) its record. Pure: does not persist or post. */
export function mergeWireRecord(
  txn: NormalizedTxn,
  cls: WireClassification,
  match: WirePeriodMatch | null,
  existing: WireEventRecord | null,
  now: string,
): WireEventRecord {
  const base: WireEventRecord = existing ?? {
    transactionId: txn.transactionId ?? "",
    amount: null,
    amountAbs: null,
    counterpartyName: null,
    bankDescription: null,
    kind: null,
    status: null,
    createdAt: null,
    estimatedDeliveryDate: null,
    dashboardLink: null,
    matchedPeriod: null,
    postedToSlack: false,
    postedAt: null,
    failureNotified: false,
    statusHistory: [],
    firstSeenAt: now,
    updatedAt: now,
  };
  const statusHistory = [...base.statusHistory];
  if (txn.status && statusHistory[statusHistory.length - 1] !== txn.status) statusHistory.push(txn.status);
  return {
    ...base,
    transactionId: txn.transactionId ?? base.transactionId,
    amount: txn.amount ?? base.amount,
    amountAbs: cls.amountAbs ?? base.amountAbs,
    counterpartyName: txn.counterpartyName ?? base.counterpartyName,
    bankDescription: txn.bankDescription ?? base.bankDescription,
    kind: txn.kind ?? base.kind,
    status: txn.status ?? base.status,
    createdAt: txn.createdAt ?? base.createdAt,
    estimatedDeliveryDate: txn.estimatedDeliveryDate ?? base.estimatedDeliveryDate,
    dashboardLink: txn.dashboardLink ?? base.dashboardLink,
    // A newly-found match wins; otherwise keep any match we had. Never clobber a real match with null.
    matchedPeriod: match ?? base.matchedPeriod,
    statusHistory,
    updatedAt: now,
  };
}

// ── Message / card building (Viktor voice, house COMMS_STYLE: no dashes, no emoji) ────────────────────
export function formatUsd(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "an unknown amount";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** ISO or YYYY-MM-DD to "Oct 29, 2026" (UTC, no tz drift). Null/unparseable yields null. */
export function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** The "wire sent" alert as a shared BotCard. Body runs through humanize() so it is dash and emoji free. */
export function wireAlertCard(rec: WireEventRecord): BotCard {
  const amount = formatUsd(rec.amountAbs);
  const dateStr = fmtDate(rec.createdAt);
  // Show the pay period ONLY when we can actually tie the wire to one; when we can't, omit the line entirely
  // rather than printing "unconfirmed" noise. The body is a short one-liner so the tile isn't doubled up with
  // the fields below.
  const periodLabel = rec.matchedPeriod?.periodLabel ?? null;
  const fields = [
    { label: "Amount", value: amount },
    { label: "Counterparty", value: rec.counterpartyName ?? "unknown" },
    { label: "Status", value: rec.status ?? "unknown" },
    ...(periodLabel ? [{ label: "Pay period", value: periodLabel }] : []),
    { label: "Mercury ref", value: rec.transactionId },
  ];
  const body = humanize(
    `Wire to Gusto sent${amount ? `, ${amount}` : ""}${dateStr ? ` on ${dateStr}` : ""}${periodLabel ? ` for the ${periodLabel} pay period` : ""}. Confirm it inside Gusto.`,
  );
  return {
    title: "Wire to Gusto sent",
    fields,
    body,
    link: { text: "Open in Mercury", url: rec.dashboardLink },
    context: "Payroll Bot. Next step, confirm the wire inside Gusto.",
  };
}

/** The one-time "failed" update, posted only if a wire we already announced later reports a failed status. */
export function wireFailedCard(rec: WireEventRecord): BotCard {
  const amount = formatUsd(rec.amountAbs);
  const body = humanize(
    `Heads up, the Gusto payroll wire now shows a failed status in Mercury. Amount ${amount}, Mercury ref ${rec.transactionId}. Please check Mercury and reconfirm that payroll was funded.`,
  );
  return {
    title: "Gusto payroll wire failed",
    fields: [
      { label: "Amount", value: amount },
      { label: "Counterparty", value: rec.counterpartyName ?? "unknown" },
      { label: "Status", value: rec.status ?? "failed" },
      { label: "Mercury ref", value: rec.transactionId },
    ],
    body,
    link: { text: "Open in Mercury", url: rec.dashboardLink },
    context: "Payroll Bot. This wire needs a human check in Mercury.",
  };
}
