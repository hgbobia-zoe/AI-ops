// Lost-reason tracker. Goodshuffle stores no reason a quote was lost (and no lost date), so the team has to
// record one. When a quote becomes lost and nobody records why within a grace period, we ask: one post in
// the sales Slack channel and one task on the GS project for the sales lead. Once per project, forever.
//
// A reason is either:
//   • a tag picked on /salesos/lost (bookings.loss_reason), or
//   • a GS internal note written after the loss (new note lines vs the snapshot taken when tracking began,
//     ignoring the lines Zoe itself appended through note_append).
//
// Cutoff: only quotes that become lost after this shipped, plus a one-time backfill of quotes lost in the
// 30 days before. The ~1,700 older lost quotes are never tracked, so they are never flagged.
//
// RULES CALCULATE (no LLM). Kill switch: LOSS_REASON_FLAGS=false.

import { flagOn } from "@/lib/flags";
import { getJson, setJson } from "@/lib/kv";
import { notify } from "@/lib/notify/channels";
import { appUrl } from "@/lib/notify/aiBots";
import { businessHoursGate } from "@/lib/settings";
import { todayInOpsTz, shiftYmd } from "@/lib/dates";
import {
  backfillLossTracking,
  enqueueGsOp,
  gsOpDedupeKeyExists,
  lossNotesSnapshot,
  lossTrackedQuotes,
  markLossFlagged,
  markLossNote,
  zoeNoteLinesSince,
  type BookingView,
} from "@/lib/db/repo";

export const LOSS_REASON_FLAG_ENV = "LOSS_REASON_FLAGS";
export const BACKFILL_DAYS = 30;
const BACKFILL_KV_KEY = "lossReason.backfillDone";
const DEFAULT_GRACE_HOURS = 24;
const MAX_FLAGS_PER_RUN = 20; // a bulk cleanup in GS rolls over to the next tick instead of one huge burst
const TASK_DUE_DAYS = 2;
/** Goodshuffle user that gets the task when the sales lead is missing or no longer an active GS user. */
export const DEFAULT_FALLBACK_GS_USER_ID = "846939458"; // Jessie Medalla (owner's pick, 2026-11-09)

export function lossReasonFlagsEnabled(): boolean {
  return flagOn(LOSS_REASON_FLAG_ENV);
}

export function graceMs(): number {
  const h = Number(process.env.LOSS_REASON_GRACE_HOURS);
  return (Number.isFinite(h) && h >= 0 ? h : DEFAULT_GRACE_HOURS) * 3_600_000;
}

function fallbackUserId(): string {
  return process.env.LOSS_REASON_TASK_FALLBACK_USER_ID?.trim() || DEFAULT_FALLBACK_GS_USER_ID;
}

export type LossFlagState =
  | "untracked" // lost before tracking began: historical, never flagged
  | "tagged" // reason tagged in the app
  | "noted" // reason written in a GS note after the loss
  | "flagged" // asked in Slack + GS task, still no reason
  | "waiting" // inside the grace period
  | "due"; // grace is over and nobody recorded a reason: flag it on the next run

type FlagFields = Pick<BookingView, "lossReason" | "lossTrackAt" | "lossFlagAt" | "lossNoteAt">;

/** PURE: where a lost quote stands on its reason. */
export function lossFlagState(b: FlagFields, nowMs: number, grace: number = graceMs()): LossFlagState {
  if (!b.lossTrackAt) return "untracked";
  if ((b.lossReason ?? "").trim()) return "tagged";
  if (b.lossNoteAt) return "noted";
  if (b.lossFlagAt) return "flagged";
  const since = Date.parse(b.lossTrackAt);
  if (Number.isFinite(since) && nowMs - since < grace) return "waiting";
  return "due";
}

const lineSet = (s: string | null | undefined): Set<string> =>
  new Set(
    (s ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  );

/** PURE: the note lines a person added after tracking began, or null when there are none. Lines already in
 *  the snapshot and lines Zoe appended itself (its call/text logs) never count. Needs a few letters, so a
 *  stray "." or a date alone is not a reason. */
export function noteReasonText(snapshot: string | null, current: string | null, zoeLines: string[]): string | null {
  const before = lineSet(snapshot);
  const zoe = new Set<string>();
  for (const z of zoeLines) for (const l of lineSet(z)) zoe.add(l);
  const added = [...lineSet(current)].filter((l) => !before.has(l) && !zoe.has(l));
  const text = added.join("\n").trim();
  if ((text.match(/[a-z]/gi) ?? []).length < 3) return null;
  return text.slice(0, 500);
}

/** Look at freshly pulled notes on tracked quotes and record any reason written in GS. Cheap; safe to run
 *  on every notes ingest and every tick. Returns how many quotes gained a note reason. */
export function detectLossReasonNotes(now: Date = new Date()): number {
  let n = 0;
  for (const b of lossTrackedQuotes()) {
    if (!b.lossTrackAt || b.lossNoteAt || (b.lossReason ?? "").trim()) continue;
    const text = noteReasonText(lossNotesSnapshot(b.bookingId), b.internalNotes, zoeNoteLinesSince(b.bookingId, b.lossTrackAt));
    if (text) {
      markLossNote(b.bookingId, text, now.toISOString());
      n++;
    }
  }
  return n;
}

/** One-time: start tracking quotes lost in the last BACKFILL_DAYS before this shipped. They get the normal
 *  grace period from now, so the pull can re-read their GS notes before anyone is asked. */
export function ensureLossBackfill(now: Date = new Date()): number | null {
  if (getJson<boolean>(BACKFILL_KV_KEY, false)) return null;
  const sinceIso = new Date(now.getTime() - BACKFILL_DAYS * 86_400_000).toISOString();
  const sinceYmd = shiftYmd(todayInOpsTz(now), -BACKFILL_DAYS);
  const n = backfillLossTracking(sinceIso, sinceYmd, now.toISOString());
  setJson(BACKFILL_KV_KEY, true);
  return n;
}

const gsLink = (id: string): string => `https://pro.goodshuffle.com/app/project/detail?id=${id}`;
const label = (b: BookingView): string => b.eventName?.trim() || b.clientName?.trim() || `Project ${b.bookingId}`;
const leadOf = (b: BookingView): string => (b.salesLead ?? "").trim();

export const LOSS_TASK_TITLE =
  "Add the reason this quote was lost. Pick it on Lost Quotes in Zoe or write it in the internal notes.";

/** PURE: the sales Slack post for the quotes flagged this run (one line each, short, no dashes). */
export function lossFlagMessage(flagged: BookingView[], lostPageUrl: string | null): string {
  const line = (b: BookingView) => `<${gsLink(b.bookingId)}|${label(b)}>${leadOf(b) ? ` (${leadOf(b)})` : ""}`;
  const where = lostPageUrl ? `on <${lostPageUrl}|Lost Quotes>` : "on the Lost Quotes page";
  if (flagged.length === 1) {
    return `A lost quote has no reason yet: ${line(flagged[0])}. Please add why it was lost ${where} or in the Goodshuffle notes. There is a task on the project.`;
  }
  return [
    `${flagged.length} lost quotes have no reason yet. Please add why each was lost ${where} or in the Goodshuffle notes. There is a task on each project.`,
    ...flagged.map((b) => `• ${line(b)}`),
  ].join("\n");
}

export const lossTaskDedupeKey = (id: string): string => `lossreason|${id}`;

export interface LossFlagRun {
  ok: boolean;
  detail: string;
  flagged: number;
  backfilled: number | null;
  notesFound: number;
}

/** The tick job: backfill once, pick up GS note reasons, then flag each quote whose grace ran out with no
 *  reason. Slack and the task wait for business hours (a nag at 2am helps nobody); nothing is marked while
 *  held, so the quote flags on the first in-hours run. */
export async function runLossReasonFlags(now: Date = new Date()): Promise<LossFlagRun> {
  if (!lossReasonFlagsEnabled()) return { ok: true, detail: `${LOSS_REASON_FLAG_ENV}=false, off`, flagged: 0, backfilled: null, notesFound: 0 };

  const backfilled = ensureLossBackfill(now);
  const notesFound = detectLossReasonNotes(now);

  const gate = businessHoursGate(now);
  if (!gate.open) return { ok: true, detail: gate.heldDetail, flagged: 0, backfilled, notesFound };

  const nowMs = now.getTime();
  const grace = graceMs();
  const due = lossTrackedQuotes()
    .filter((b) => lossFlagState(b, nowMs, grace) === "due")
    .slice(0, MAX_FLAGS_PER_RUN);

  const flagged: BookingView[] = [];
  const dueDate = shiftYmd(todayInOpsTz(now), TASK_DUE_DAYS);
  for (const b of due) {
    if (!markLossFlagged(b.bookingId, now.toISOString())) continue; // another run got it
    flagged.push(b);
    const dedupeKey = lossTaskDedupeKey(b.bookingId);
    if (gsOpDedupeKeyExists("create_gs_task", dedupeKey)) continue;
    enqueueGsOp({
      op: "create_gs_task",
      transactionId: b.bookingId,
      label: "ask for the lost reason",
      payload: {
        transactionID: b.bookingId,
        title: LOSS_TASK_TITLE,
        dueDate, // YYYY-MM-DD; the drainer formats it for GS
        assigneeName: leadOf(b) || null, // resolved to a GS user id in the browser (active sales users only)
        fallbackUserID: fallbackUserId(),
        dedupeKey,
      },
    });
  }

  if (flagged.length > 0) {
    try {
      await notify("sales", lossFlagMessage(flagged, appUrl("/salesos/lost")));
    } catch {
      // Slack is best effort; the GS task is the durable ask
    }
  }

  const parts = [`${flagged.length} flagged`];
  if (backfilled != null) parts.push(`${backfilled} backfilled`);
  if (notesFound) parts.push(`${notesFound} reasons found in GS notes`);
  return { ok: true, detail: parts.join(", "), flagged: flagged.length, backfilled, notesFound };
}
