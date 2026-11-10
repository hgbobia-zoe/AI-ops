// Lost-reason tracker. Goodshuffle stores no reason a quote was lost (and no lost date), so the team has to
// record one, and the owner wants it in BOTH places: the reason tag in Zoe and the Goodshuffle quote note.
//
//   • Tag in Zoe (/salesos/lost)  → we also write a "Lost reason: …" line into the GS internal notes.
//   • Reason in the GS notes      → Zoe parses it and fills the tag itself, so nobody tags twice. A note
//                                   counts when a line talks about the loss ("Lost, went with another
//                                   vendor") or was written after the quote went lost. Lines Zoe appended
//                                   itself (call and text logs) never count.
//   • Sales Bot marked it lost    → the reason is known (not signed by the cutoff); filled automatically.
//   • No reason anywhere after 24h → one post in the sales Slack channel and one GS task for the sales lead
//                                   (fallback Jessie). Once per project, forever.
//
// Cutoff (owner, 2026-11-10): "Only active and future quotes. Lets ignore the past ones for now." Tracking
// starts only when the pull sees an open quote flip to lost (or a project created in the last few days
// arrives already lost). Quotes already lost at launch are never tracked, so they are never flagged.
//
// RULES CALCULATE (no LLM). Kill switch: LOSS_REASON_FLAGS=false.

import { flagOn } from "@/lib/flags";
import { notify } from "@/lib/notify/channels";
import { appUrl } from "@/lib/notify/aiBots";
import { businessHoursGate } from "@/lib/settings";
import { todayInOpsTz, shiftYmd } from "@/lib/dates";
import {
  enqueueGsOp,
  gsOpDedupeKeyExists,
  gsNoteOpExists,
  lossNotesSnapshot,
  lossTrackedQuotes,
  markLossFlagged,
  markLossNote,
  salesBotMarkedLost,
  setLossReason,
  zoeNoteLinesSince,
  type BookingView,
} from "@/lib/db/repo";
import { logSalesEventBy } from "./audit";
import { initialsOf, salesOsNoteLine } from "./noteFormat";
import { classifyLossReason, SALES_BOT_LOSS_REASON } from "./lossReasons";

export const LOSS_REASON_FLAG_ENV = "LOSS_REASON_FLAGS";
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
  | "untracked" // already lost before tracking began: never flagged
  | "tagged" // reason recorded (by a person, from the GS note, or by the Sales Bot)
  | "noted" // a GS note was found but no tag could be set (defensive; normally it fills the tag)
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

const lines = (s: string | null | undefined): string[] =>
  (s ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

/** Zoe's own automated note lines carry its prefix (`HG(by SalesOS) - …`, `SalesOS - …`) or the bot's name. */
const ZOE_LINE_RE = /\(by SalesOS\)|^SalesOS\b|\bSales Bot\b/i;
const LOSS_LINE_RE = /\b(lost|loss)\b/i;
const hasLetters = (s: string): boolean => (s.match(/[a-z]/gi) ?? []).length >= 3;

export interface NoteReason {
  text: string; // the line(s) as the rep wrote them
  reason: string; // vocabulary reason (Other when the text does not match a rule)
}

/** PURE: the loss reason a quote's GS notes hold, or null. Prefers a line that talks about the loss (it may
 *  predate the flip, a rep often writes "Lost, went with X" and then marks it lost); else the lines a person
 *  added after tracking began. Zoe's own lines never count. */
export function noteLossReason(snapshot: string | null, current: string | null, zoeLines: string[]): NoteReason | null {
  const zoe = new Set<string>();
  for (const z of zoeLines) for (const l of lines(z)) zoe.add(l);
  const human = lines(current).filter((l) => !zoe.has(l) && !ZOE_LINE_RE.test(l));

  const lossLines = human.filter((l) => LOSS_LINE_RE.test(l) && hasLetters(l.replace(LOSS_LINE_RE, "")));
  // Latest loss line with a recognisable reason wins; else the latest loss line.
  const classified = [...lossLines].reverse().find((l) => classifyLossReason(l));
  const pick = classified ?? lossLines[lossLines.length - 1];
  if (pick) return { text: pick.slice(0, 500), reason: classifyLossReason(pick) ?? "Other" };

  const before = new Set(lines(snapshot));
  const added = human.filter((l) => !before.has(l)).join("\n").trim();
  if (!hasLetters(added)) return null;
  return { text: added.slice(0, 500), reason: classifyLossReason(added) ?? "Other" };
}

/** Queue the reason into the project's GS internal notes (the existing, proven note_append op). Deduped per
 *  project + reason, so re-picking the same reason never writes it twice. `actorName` is the person who
 *  tagged it (null for the Sales Bot / system). */
export function queueLossReasonNote(bookingId: string, reason: string, actorName: string | null, now: Date = new Date()): boolean {
  const dedupeKey = `lossreason-note|${bookingId}|${reason}`;
  if (gsNoteOpExists(dedupeKey)) return false;
  const comment = `Lost reason: ${reason.replace(/\s*[—–]\s*/g, ", ")}`;
  const line = salesOsNoteLine(actorName ? initialsOf(actorName) : null, comment, todayInOpsTz(now));
  enqueueGsOp({ op: "note_append", transactionId: bookingId, label: "lost reason to GS note", payload: { line, dedupeKey } });
  return true;
}

/** Fill the reason wherever it is already known: the Sales Bot's own mark-lost, or the GS notes. Cheap; runs
 *  on every notes ingest and every tick. Returns how many quotes got a reason. */
export function fillKnownLossReasons(now: Date = new Date()): number {
  let n = 0;
  for (const b of lossTrackedQuotes()) {
    if (!b.lossTrackAt || b.lossNoteAt || (b.lossReason ?? "").trim()) continue;
    if (salesBotMarkedLost(b.bookingId)) {
      setLossReason(b.bookingId, SALES_BOT_LOSS_REASON, "sales_bot");
      logSalesEventBy("LOSS_REASON_TAGGED", b.bookingId, "Sales Bot", { reason: SALES_BOT_LOSS_REASON, source: "sales_bot" });
      queueLossReasonNote(b.bookingId, SALES_BOT_LOSS_REASON, null, now);
      n++;
      continue;
    }
    const found = noteLossReason(lossNotesSnapshot(b.bookingId), b.internalNotes, zoeNoteLinesSince(b.bookingId, ""));
    if (found) {
      markLossNote(b.bookingId, found.text, now.toISOString());
      setLossReason(b.bookingId, found.reason, "gs_note");
      logSalesEventBy("LOSS_REASON_TAGGED", b.bookingId, "Goodshuffle note", { reason: found.reason, source: "gs_note", note: found.text });
      n++;
    }
  }
  return n;
}

const gsLink = (id: string): string => `https://pro.goodshuffle.com/app/project/detail?id=${id}`;
const label = (b: BookingView): string => b.eventName?.trim() || b.clientName?.trim() || `Project ${b.bookingId}`;
const leadOf = (b: BookingView): string => (b.salesLead ?? "").trim();

export const LOSS_TASK_TITLE =
  "Add the reason this quote was lost. Write it in the internal notes (for example: Lost, went with another vendor) or pick it on Lost Quotes in Zoe.";

/** PURE: the sales Slack post for the quotes flagged this run (one line each, short, no dashes). */
export function lossFlagMessage(flagged: BookingView[], lostPageUrl: string | null): string {
  const line = (b: BookingView) => `<${gsLink(b.bookingId)}|${label(b)}>${leadOf(b) ? ` (${leadOf(b)})` : ""}`;
  const where = lostPageUrl ? `on <${lostPageUrl}|Lost Quotes>` : "on the Lost Quotes page";
  if (flagged.length === 1) {
    return `A lost quote has no reason yet: ${line(flagged[0])}. Please add why it was lost in the Goodshuffle notes or ${where}. There is a task on the project.`;
  }
  return [
    `${flagged.length} lost quotes have no reason yet. Please add why each was lost in the Goodshuffle notes or ${where}. There is a task on each project.`,
    ...flagged.map((b) => `• ${line(b)}`),
  ].join("\n");
}

export const lossTaskDedupeKey = (id: string): string => `lossreason|${id}`;

export interface LossFlagRun {
  ok: boolean;
  detail: string;
  flagged: number;
  filled: number;
}

/** The tick job: fill reasons already known, then flag each quote whose grace ran out with no reason. Slack
 *  and the task wait for business hours (a nag at 2am helps nobody); nothing is marked while held, so the
 *  quote flags on the first in-hours run. */
export async function runLossReasonFlags(now: Date = new Date()): Promise<LossFlagRun> {
  if (!lossReasonFlagsEnabled()) return { ok: true, detail: `${LOSS_REASON_FLAG_ENV}=false, off`, flagged: 0, filled: 0 };

  const filled = fillKnownLossReasons(now);

  const gate = businessHoursGate(now);
  if (!gate.open) return { ok: true, detail: gate.heldDetail, flagged: 0, filled };

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
  if (filled) parts.push(`${filled} reasons filled from GS notes or the Sales Bot`);
  return { ok: true, detail: parts.join(", "), flagged: flagged.length, filled };
}
