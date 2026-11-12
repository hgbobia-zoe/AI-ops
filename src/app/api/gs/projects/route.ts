// Ingest Goodshuffle BOOKINGS (projects) — the commercial pipeline behind Sales, Finance, and
// Customer. Posted by the office pull (runs inside a logged-in, full-access Goodshuffle tab, which
// can see financials the driver/tablet account can't). Amounts arrive in CENTS and are stored as
// dollars. CORS-restricted to the Goodshuffle origin, same as /api/route/import.
//
// Body: { projects: [{ bookingId, eventName?, eventDate?(YYYY-MM-DD|null), statusLabel?, signed?,
//   grandTotalCents?, contractTotalCents?, amountPaidCents?, amountDueCents?, clientName?, clientEmail? }],
//   scope?: "active" | "full", partial?: boolean,
//   windows?: [{ bookingId, events: [{ marker: "DROP_OFF"|"PICK_UP", name, dateLabel }] }] }
//
// `windows` = the project timeline delivery windows (initProjectTimeline logisticsDelivery entries) the
// pulls fetch for projects with logistics in a short horizon. Sent in its own POST (no projects[]), like
// `components`. A booking listed here had its timeline fetched: its stored windows are replaced (an empty
// events[] clears them). Parsing happens server side (onTime.parseTimelineWindows).
//
// TWO-TIER PULL (scope):
//   • "full" (DEFAULT when scope is absent — so the bookmarklet and any existing caller keep working):
//     the archive-inclusive walk (~2.7k incl. archived/Lost). Runs the orphan-prune, the human-armed
//     force-prune, and the sustained-failure probe exactly as before.
//   • "active": the fast-lane refresh of ONLY the ~88 active, non-archived projects. Upserts + keeps
//     freshness green, but must NEVER prune — an active-only set carries no archived rows, so every
//     archived project would look like an orphan and get wrongly archived. The prune / force-prune /
//     failure-probe are STRUCTURALLY unreachable on this path (early return below). `partial` is a
//     full-lane concept and is ignored here.

import { runSignedAlerts } from "@/lib/salesos/signedAlert";
import { NextResponse } from "next/server";
import {
  saveBookings,
  enqueueWarehouseTeamAdds,
  archiveBookingsNotIn,
  saveBookingRevenueComponents,
  saveBookingTimelineWindows,
  syncStopWindowsFromBookings,
  lossNoteWatchIds,
  type BookingRecord,
  type BookingTimelineInput,
} from "@/lib/db/repo";
import { lossReasonFlagsEnabled } from "@/lib/salesos/lossReasonFlag";
import { watchPaidIncreases, paymentWatchIds } from "@/lib/payments/offlineConfirmService";
import type { RawTimelineEvent } from "@/lib/dispatch/onTime";
import { recordPull, logImport, recordBookingsImportFailure, claimBlankDraftBurstAlert } from "@/lib/pull/state";
import { findBlankDraftBursts, blankDraftBurstAlert, BLANK_DRAFT_BURST_THRESHOLD } from "@/lib/ingest/blankDraft";
import { todayInOpsTz, shiftYmd } from "@/lib/dates";
import { consumeBookingsForcePrune } from "@/lib/ingest/forcePruneBookings";
import { postStatus } from "@/lib/notify/status";
import { centsToDollars, type RevenueComponentsCents } from "@/lib/finance/revenueModel";

/** How far back a bookings pull refreshes stop windows (covers the recent on-time review period). */
const WINDOW_BACKFILL_DAYS = 60;
/** Re-read GS notes on a lost quote for this long after tracking began, at most this many per pull. */
const LOSS_NOTE_WATCH_DAYS = 14;
const LOSS_NOTE_WATCH_CAP = 25;

export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "https://pro.goodshuffle.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-publish-token",
  Vary: "Origin",
};

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

interface InProject {
  bookingId?: string | number;
  eventName?: string;
  eventDate?: string | null;
  statusLabel?: string;
  signed?: boolean;
  grandTotalCents?: number;
  contractTotalCents?: number;
  amountPaidCents?: number;
  amountDueCents?: number;
  clientName?: string;
  clientEmail?: string;
  clientPhone?: string;
  quoteSentDate?: string | null;
  dateCreated?: string | null;
  venue?: string | null;
  location?: string | null;
  salesLead?: string | null; // Goodshuffle salesLeadName
  archived?: boolean;
  logisticsStartTime?: string | null; // Goodshuffle logistics_start_from_time ("9:00 AM EDT" | "TBD"): delivery window start
  streetAddress?: string | null; // Goodshuffle streetLine1 (+ streetLine2): the venue street, for delivery pricing
}

const dollars = (cents: number | undefined): number | null =>
  typeof cents === "number" && Number.isFinite(cents) ? Math.round(cents) / 100 : null;

// Stage 3 revenue components arrive in CENTS (same as every other GS amount), keyed by bookingId, from the
// per-tx loadPaymentHistoryAndContractTotals call the office pull already makes during route enrichment.
// Each is converted to dollars (÷100) and persisted to the sibling booking_revenue_components table. This
// is additive breakdown — it does NOT touch `bookings` (still the grand_total SoT). A missing field is null.
interface InRevenueComponents extends Partial<RevenueComponentsCents> {
  bookingId?: string | number;
}
function persistComponents(components: InRevenueComponents[]): number {
  const rows: Array<{ bookingId: string; components: ReturnType<typeof centsToDollars> }> = [];
  for (const c of components) {
    const id = c.bookingId != null ? String(c.bookingId) : "";
    if (!id) continue;
    const cents: RevenueComponentsCents = {
      quotedSubtotal: c.quotedSubtotal ?? null,
      contractTotal: c.contractTotal ?? null,
      grandTotal: c.grandTotal ?? null,
      productSubtotal: c.productSubtotal ?? null,
      productRentalsSubtotal: c.productRentalsSubtotal ?? null,
      productSalesSubtotal: c.productSalesSubtotal ?? null,
      serviceSubtotal: c.serviceSubtotal ?? null,
      logisticsSubtotal: c.logisticsSubtotal ?? null,
      detachedItemSubtotal: c.detachedItemSubtotal ?? null,
      discount: c.discount ?? null,
      additionalDiscount: c.additionalDiscount ?? null,
      discountSubtotal: c.discountSubtotal ?? null,
      taxableSubtotal: c.taxableSubtotal ?? null,
      taxTotal: c.taxTotal ?? null,
      effectiveTaxRate: c.effectiveTaxRate ?? null,
      collected: c.collected ?? null,
      refunds: c.refunds ?? null,
      processingFees: c.processingFees ?? null,
      goodshuffleFees: c.goodshuffleFees ?? null,
    };
    rows.push({ bookingId: id, components: centsToDollars(cents) });
  }
  if (rows.length > 0) saveBookingRevenueComponents(rows);
  return rows.length;
}

const ymd = (s: string | null | undefined): string | null => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

/** Keep only well-formed timeline entries (strings, bounded) from the pull. */
interface InWindows {
  bookingId?: string | number;
  events?: unknown;
}
function sanitizeWindows(raw: InWindows[]): BookingTimelineInput[] {
  const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const out: BookingTimelineInput[] = [];
  for (const w of raw.slice(0, 500)) {
    const bookingId = w?.bookingId != null ? String(w.bookingId).trim() : "";
    if (!bookingId || !Array.isArray(w.events)) continue; // no events[] = the fetch failed: keep what is stored
    const events: RawTimelineEvent[] = (w.events as Array<Record<string, unknown>>).slice(0, 40).map((e) => ({
      marker: str(e?.marker, 20),
      name: str(e?.name, 120),
      dateLabel: str(e?.dateLabel, 120),
    }));
    out.push({ bookingId, events });
  }
  return out;
}

/** Store fetched project timeline windows and refresh the windows on stops already written. */
function persistWindows(raw: InWindows[]): { bookings: number; windows: number; stopsUpdated: number } {
  const items = sanitizeWindows(raw);
  if (items.length === 0) return { bookings: 0, windows: 0, stopsUpdated: 0 };
  const today = todayInOpsTz();
  const windows = saveBookingTimelineWindows(items, today);
  let stopsUpdated = 0;
  try {
    stopsUpdated = syncStopWindowsFromBookings(shiftYmd(today, -WINDOW_BACKFILL_DAYS));
  } catch (e) {
    console.error("[gs/projects] syncStopWindowsFromBookings after windows failed (ignored)", e);
  }
  return { bookings: items.length, windows, stopsUpdated };
}

export async function POST(req: Request): Promise<NextResponse> {
  const publishToken = process.env.GS_INGEST_TOKEN;
  if (publishToken && req.headers.get("x-publish-token") !== publishToken) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }
  let body: {
    projects?: InProject[];
    components?: InRevenueComponents[];
    windows?: InWindows[];
    partial?: boolean;
    totalReported?: number;
    scope?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }
  // scope defaults to "full" when absent, so the bookmarklet / any existing caller is unchanged.
  const scope: "active" | "full" = body.scope === "active" ? "active" : "full";
  const projects = Array.isArray(body.projects) ? body.projects : [];
  const components = Array.isArray(body.components) ? body.components : [];
  const windowsIn = Array.isArray(body.windows) ? body.windows : [];
  if (projects.length === 0 && components.length === 0 && windowsIn.length === 0) {
    return NextResponse.json({ error: "projects[], components[] or windows[] required" }, { status: 400, headers: CORS });
  }

  // Timeline-windows-only POST: the pull fetches each near-term project's timeline after the bookings
  // POST and sends the windows on their own. None of the upsert / prune / freshness logic applies.
  if (projects.length === 0 && components.length === 0) {
    const w = persistWindows(windowsIn);
    return NextResponse.json({ ok: true, scope, saved: 0, pruned: 0, windowBookings: w.bookings, windows: w.windows, stopsUpdated: w.stopsUpdated }, { headers: CORS });
  }

  // Revenue-components-only POST (Stage 3): the office pull sends the per-tx breakdown in its own call,
  // carrying no projects[]. Persist the breakdown and return — none of the bookings upsert / prune /
  // freshness logic applies (this is additive revenue detail, not a pipeline refresh).
  if (projects.length === 0) {
    const savedComponents = persistComponents(components);
    const w = windowsIn.length > 0 ? persistWindows(windowsIn) : null;
    return NextResponse.json({ ok: true, savedComponents, scope, saved: 0, pruned: 0, ...(w ? { windows: w.windows } : {}) }, { headers: CORS });
  }
  // Components may also ride alongside a projects pull (harmless) — persist them first.
  const savedComponents = components.length > 0 ? persistComponents(components) : 0;

  const records: BookingRecord[] = [];
  for (const p of projects) {
    const id = p.bookingId != null ? String(p.bookingId) : "";
    if (!id) continue;
    records.push({
      bookingId: id,
      eventName: p.eventName,
      eventDate: ymd(p.eventDate),
      statusLabel: p.statusLabel,
      signed: Boolean(p.signed),
      contractTotal: dollars(p.contractTotalCents),
      grandTotal: dollars(p.grandTotalCents),
      amountPaid: dollars(p.amountPaidCents),
      amountDue: dollars(p.amountDueCents),
      clientName: p.clientName,
      clientEmail: p.clientEmail,
      clientPhone: p.clientPhone,
      quoteSentDate: ymd(p.quoteSentDate),
      dateCreated: ymd(p.dateCreated),
      venue: p.venue?.trim() || null,
      location: p.location?.trim() || null,
      salesLead: p.salesLead === undefined ? undefined : p.salesLead?.trim() || null,
      archived: Boolean(p.archived),
      // undefined = an older pull build that does not send it (keep the stored window).
      windowStartTime: p.logisticsStartTime === undefined ? undefined : typeof p.logisticsStartTime === "string" ? p.logisticsStartTime : null,
      streetAddress: p.streetAddress === undefined ? undefined : typeof p.streetAddress === "string" ? p.streetAddress : null,
    });
  }
  // Date drift guard. Every real Goodshuffle project has a created date, so a batch where NONE has one means
  // the pull could not read Goodshuffle's date fields (it renamed them to *_millis in Nov 2026 and an older
  // pull build blanked every date). Keep the stored dates and delivery windows instead of erasing them.
  const dateDrift = records.length >= 5 && records.every((r) => !r.dateCreated);
  if (dateDrift) {
    for (const r of records) {
      r.eventDate = undefined;
      r.windowStartTime = undefined;
    }
    console.warn(`[gs/projects] ${records.length} projects arrived with no dates; kept the stored dates (pull build is out of date)`);
  }
  // Offline payment confirmation: a project whose amount paid went up goes on the payment watch list
  // (compared against the stored row, so this runs BEFORE the upsert). Best effort.
  let paymentWatched = 0;
  if (records.length > 0) {
    try {
      paymentWatched = watchPaidIncreases(records);
    } catch (e) {
      console.error("[gs/projects] watchPaidIncreases failed (ignored)", e);
    }
  }
  if (records.length > 0) saveBookings(records);
  // Contract-signed card for any project this save saw go from unsigned to signed. Best effort, async.
  if (records.length > 0) void runSignedAlerts().catch(() => {});
  // Timeline windows may also ride alongside a projects pull: store them after the bookings rows exist
  // (their year is read from the booking's logistics date). The stop refresh below covers them.
  if (windowsIn.length > 0) {
    try {
      saveBookingTimelineWindows(sanitizeWindows(windowsIn), todayInOpsTz());
    } catch (e) {
      console.error("[gs/projects] saveBookingTimelineWindows failed (ignored)", e);
    }
  }
  // Bookings and routes arrive in separate pulls: refresh the customer window on stops already written
  // (recent + upcoming routes) from the projects just saved. Best effort; never fails the ingest.
  if (records.length > 0 || windowsIn.length > 0) {
    try {
      syncStopWindowsFromBookings(shiftYmd(todayInOpsTz(), -WINDOW_BACKFILL_DAYS));
    } catch (e) {
      console.error("[gs/projects] syncStopWindowsFromBookings failed (ignored)", e);
    }
  }

  // Runaway-create guard (both lanes): more than N blank drafts created today or yesterday means a create
  // loop is minting empty projects (the 2026-10-31 incident made 68 before anyone noticed). One deduped
  // ops Slack per day. Never fails the ingest.
  const blankDraftAlerts = alertBlankDraftBursts(records);

  // ── FAST LANE (scope:"active") ────────────────────────────────────────────────────────────────
  // Upsert the active set and keep freshness green between hourly full pulls — then STOP. There is no
  // orphan concept on an active-only set (it never carries archived rows), so the prune, the one-shot
  // force-prune, and the sustained-failure probe are all skipped here, structurally. This early return
  // is the single point that enforces "only the FULL pull prunes": an active pull cannot reach any of
  // that code below, so it can never archive a row or consume an armed force-prune flag.
  if (scope === "active") {
    logImport("bookings", true, { rowsIn: projects.length, rowsWritten: records.length, detail: "active refresh" });
    if (records.length > 0) recordPull("bookings", records.length);
    // Warehouse-team adds are idempotent (add-once) and signed active projects appear in this set, so it
    // is safe + useful on the fast lane; it never prunes or deletes.
    const wdQueued = records.length > 0 ? enqueueWarehouseTeamAdds() : 0;
    // Lost-reason tracker: recently lost quotes still missing a reason. They are off the open-lead notes
    // capture, so the pull re-reads their GS notes (a reason written there clears the flag).
    const lossNoteIds = lossReasonFlagsEnabled() ? lossNoteWatchIds(new Date(Date.now() - LOSS_NOTE_WATCH_DAYS * 86_400_000).toISOString(), LOSS_NOTE_WATCH_CAP) : [];
    // Offline payment confirmation: projects whose payment history the pull should read next (it posts
    // them to /api/gs/payments). Includes any put on the watch list by the full lane.
    let paymentIds: string[] = [];
    try {
      paymentIds = paymentWatchIds();
    } catch (e) {
      console.error("[gs/projects] paymentWatchIds failed (ignored)", e);
    }
    return NextResponse.json({ ok: true, saved: records.length, savedComponents, scope, partial: false, wdQueued, pruned: 0, blankDraftAlerts, lossNoteIds, paymentWatched, paymentIds }, { headers: CORS });
  }

  // ── SLOW LANE (scope:"full", or absent) ─────────────────────────────────────────────────────────
  // A partial pull (the bookmarklet hit a pagination error) must NOT be treated as fresh/complete —
  // otherwise Sales/Finance/Customer run on a truncated pipeline that looks whole.
  const partial = Boolean(body.partial) || (typeof body.totalReported === "number" && body.totalReported > records.length);
  const detail = partial
    ? `partial pull: saved ${records.length}${typeof body.totalReported === "number" ? ` of ~${body.totalReported}` : ""}`
    : undefined;
  logImport("bookings", !partial, { rowsIn: projects.length, rowsWritten: records.length, detail });
  if (!partial && records.length > 0) recordPull("bookings", records.length);

  // Prune deleted-in-GS orphans: GS DELETES projects (not just marks them Lost), and an upsert pull never
  // removes a row GS stopped returning — so a deleted quote lingers as a phantom open quote. On a COMPLETE
  // pull (not partial) carrying a real full set, archive any booking GS no longer returns. The >=100 floor
  // plus the per-call cap (archiveBookingsNotIn skips if it would archive more than a handful) guard against
  // a silently-truncated pull wrongly mass-archiving live projects.
  //
  // One-shot FORCE override: when a human has armed Force-archive in /admin (e.g. they just deleted a large
  // batch of placeholder projects on purpose, so the orphans legitimately exceed the cap), the SAME safety
  // floor still holds — we only force on a COMPLETE pull with a real full set (>=100) — but we lift the
  // per-call cap for exactly this one pull, then disarm. The flag is only read (and cleared) when the pull
  // is actually eligible, so a partial/tiny pull can never silently consume the arming.
  const eligible = !partial && records.length >= 100;
  const forced = eligible && consumeBookingsForcePrune(); // one-shot: reads AND clears, only when it can act
  let prune: { archived: number; skipped: boolean; candidates: number } = { archived: 0, skipped: false, candidates: 0 };
  if (eligible) {
    // Forced: lift the cap for this one complete pull. Unarmed: the conservative cap of 15.
    prune = archiveBookingsNotIn(records.map((r) => r.bookingId), forced ? records.length : 15);
  }
  if (forced) {
    // Human-confirmed bulk deletion swept. Log it as a SUCCESS with an explicit audited detail.
    logImport("bookings", true, {
      rowsIn: projects.length,
      rowsWritten: records.length,
      detail: `force-prune: archived ${prune.archived} orphans (human-confirmed bulk deletion)`,
    });
  } else if (prune.skipped) {
    logImport("bookings", false, { rowsIn: projects.length, rowsWritten: records.length, detail: "prune skipped — too many orphans, likely a truncated pull" });
  }
  const pruned = prune.archived;

  // Sustained-failure alert (the loud signal the import ledger alone didn't fire). Only evaluate on an
  // eligible (complete, full) pull: a skip pages a human to decide (truncated pull, or arm Force-archive),
  // a clean/forced prune clears it. Wrapped so a Slack hiccup NEVER breaks the ingest write.
  if (eligible) {
    const probe = prune.skipped
      ? recordBookingsImportFailure(false, `${prune.candidates} active projects missing from the pull`)
      : recordBookingsImportFailure(true, forced ? `${prune.archived} orphans archived (forced)` : `${prune.archived} orphans archived`);
    if (probe.alert) {
      try {
        void postStatus(probe.alert);
      } catch {
        /* a Slack failure must never fail the ingest */
      }
    }
  }

  // Auto-add the Warehouse Desktop account to every SIGNED project's GSPRO team (add-once, batched)
  // so the warehouse tablet/workstation sees signed work. The office extension drains these ops.
  const wdQueued = records.length > 0 ? enqueueWarehouseTeamAdds() : 0;

  return NextResponse.json({ ok: true, saved: records.length, savedComponents, scope, partial, wdQueued, pruned, blankDraftAlerts, paymentWatched }, { headers: CORS });
}

/** Threshold for the blank-draft guard. GS_BLANK_DRAFT_ALERT_THRESHOLD overrides the default of 5. */
function blankDraftThreshold(): number {
  const n = Number(process.env.GS_BLANK_DRAFT_ALERT_THRESHOLD);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : BLANK_DRAFT_BURST_THRESHOLD;
}

/** Post one ops Slack per day that crosses the blank-draft threshold. Returns how many alerts were sent. */
function alertBlankDraftBursts(records: BookingRecord[]): number {
  try {
    const since = shiftYmd(todayInOpsTz(), -1);
    let sent = 0;
    for (const burst of findBlankDraftBursts(records, since, blankDraftThreshold())) {
      if (!claimBlankDraftBurstAlert(burst.date)) continue;
      sent++;
      void postStatus(blankDraftBurstAlert(burst));
    }
    return sent;
  } catch {
    return 0; // the guard must never break the ingest write
  }
}
