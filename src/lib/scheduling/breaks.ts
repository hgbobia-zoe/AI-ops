// Employee break management — the PURE engine (no DB, no sends, fully unit-tested). It decides, from a
// shift's window and the breaks already recorded, WHEN a break reminder is due and WHETHER a break looks
// missed. It never records a break, never deducts time, and never marks anyone compliant — those are facts
// the time system owns (rules calculate; verified beats assumed).
//
// COMPLIANCE NOTE (read breakConfig.ts for the sourced findings): the default > 5h policy is ZOE'S INTERNAL
// policy, NOT a statutory requirement. Maryland, DC and Virginia do not mandate meal/rest breaks for adult
// non-retail workers; MD mandates breaks for MINORS (under 18). We therefore do NOT hardcode a legal rule;
// policies are configurable and jurisdiction/age aware, and any statutory-compliance behavior stays gated
// until HR approves it (see breakConfig + the report).
//
// House comms style (comms-no-dashes): reminders are short, natural, no dashes, no emoji.

export interface BreakPolicy {
  /** Shift length (hours) at or above which a break reminder applies. Default 5 (internal policy). */
  thresholdHours: number;
  /** Fraction of the shift at which to aim the reminder (0.5 = midway). */
  reminderFraction: number;
  /** Minimum minutes worked before a reminder can fire (so a reminder never lands in the first minutes). */
  minWorkedMinutes: number;
  /** A recorded break of at least this many minutes counts as "taken" (suppresses the reminder). */
  qualifyingBreakMinutes: number;
  /** Avoid reminding within this many minutes of a known critical activity (load/unload/install/stop). */
  criticalBufferMinutes: number;
}

export interface BreakRecord {
  /** ISO when the break started. */
  start: string;
  /** ISO when it ended, or null if still on break / open. */
  end?: string | null;
}

export interface BreakComputeInput {
  shiftStart: string; // ISO
  shiftEnd: string; // ISO
  now: string; // ISO
  policy: BreakPolicy;
  /** Breaks already recorded in the time system for this shift (verified facts). */
  recordedBreaks: BreakRecord[];
  /** Known critical activity times to avoid reminding during (e.g. scheduled stop windows). Best-effort. */
  criticalWindows?: string[]; // ISO
}

export type BreakDecision =
  | { action: "not_eligible"; reason: string }
  | { action: "not_due"; reminderAt: string }
  | { action: "skip"; reason: "already_recorded" }
  | { action: "remind"; reminderAt: string; adjustedForActivity: boolean }
  | { action: "missed"; reason: string };

const MIN = 60_000;
const HOUR = 3_600_000;

export function shiftDurationHours(startIso: string, endIso: string): number {
  const d = (Date.parse(endIso) - Date.parse(startIso)) / HOUR;
  return Number.isFinite(d) && d > 0 ? d : 0;
}

export function isBreakEligible(startIso: string, endIso: string, policy: BreakPolicy): boolean {
  return shiftDurationHours(startIso, endIso) >= policy.thresholdHours;
}

/** A recorded break "qualifies" (suppresses the reminder) when it is in progress (no end) or lasted at least
 *  the policy's qualifying minutes. A too-short completed break does not qualify. */
function hasQualifyingBreak(records: BreakRecord[], policy: BreakPolicy): boolean {
  return records.some((r) => {
    const start = Date.parse(r.start);
    if (!Number.isFinite(start)) return false;
    if (!r.end) return true; // currently on break
    const dur = (Date.parse(r.end) - start) / MIN;
    return dur >= policy.qualifyingBreakMinutes;
  });
}

/** The target reminder instant: `reminderFraction` into the shift, but never before `minWorkedMinutes`. */
function targetReminderMs(startMs: number, endMs: number, policy: BreakPolicy): number {
  const frac = startMs + (endMs - startMs) * policy.reminderFraction;
  const floor = startMs + policy.minWorkedMinutes * MIN;
  return Math.max(frac, floor);
}

/** Push the reminder past any critical window it collides with (predictable fallback), capped so it still
 *  leaves room before shift end. Returns the (possibly unchanged) instant + whether it moved. */
function avoidCriticalWindows(targetMs: number, endMs: number, policy: BreakPolicy, windows: string[]): { at: number; adjusted: boolean } {
  const bufferMs = policy.criticalBufferMinutes * MIN;
  const latest = endMs - policy.qualifyingBreakMinutes * MIN; // leave room to actually take the break
  let at = targetMs;
  let adjusted = false;
  // Sort collisions and step past each; bounded by the number of windows (no infinite loop).
  const sorted = windows.map(Date.parse).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  for (const w of sorted) {
    if (Math.abs(at - w) <= bufferMs && at <= latest) {
      at = Math.min(w + bufferMs, latest);
      adjusted = true;
    }
  }
  return { at, adjusted };
}

/**
 * Decide the break action for one shift at `now`. Pure and deterministic.
 * - not_eligible: shift shorter than the policy threshold.
 * - skip: a qualifying break is already recorded (do not nag).
 * - not_due: eligible, no break yet, but the reminder time has not arrived.
 * - remind: eligible, no break, reminder time reached while the shift is still running.
 * - missed: the shift has ended and no qualifying break was recorded (an exception to surface, NOT a
 *   compliance verdict and NOT a time deduction).
 */
export function computeBreakDecision(input: BreakComputeInput): BreakDecision {
  const { shiftStart, shiftEnd, now, policy, recordedBreaks, criticalWindows = [] } = input;
  if (!isBreakEligible(shiftStart, shiftEnd, policy)) {
    return { action: "not_eligible", reason: `shift under ${policy.thresholdHours}h` };
  }
  const startMs = Date.parse(shiftStart);
  const endMs = Date.parse(shiftEnd);
  const nowMs = Date.parse(now);

  if (hasQualifyingBreak(recordedBreaks, policy)) return { action: "skip", reason: "already_recorded" };

  const target = targetReminderMs(startMs, endMs, policy);
  const { at, adjusted } = avoidCriticalWindows(target, endMs, policy, criticalWindows);
  const reminderAtIso = new Date(at).toISOString();

  if (nowMs >= endMs) return { action: "missed", reason: "shift ended with no recorded break" };
  if (nowMs >= at) return { action: "remind", reminderAt: reminderAtIso, adjustedForActivity: adjusted };
  return { action: "not_due", reminderAt: reminderAtIso };
}

/** The reminder message. Short, natural, no dashes, no emoji. firstName may be blank (then a generic open). */
export function renderBreakReminder(firstName?: string | null): string {
  const name = firstName && firstName.trim() ? firstName.trim() : "there";
  return `Hi ${name}, it's time to take your break. Please coordinate with your team and record your break in Connecteam.`;
}
