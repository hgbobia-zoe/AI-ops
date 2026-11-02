// "Payroll submitted but no wire yet" reminder. After payroll is submitted in Gusto (the submit ledger in
// gustoSubmitState), the wire to Gusto still has to go out from Mercury. If no wire shows up, the payroll
// channel would otherwise stay quiet. This check runs on the runtime clock and posts to the payroll channel:
//   1st reminder: 2 hours after the submit,
//   2nd reminder: 10am ET the next day,
// then stops. It stops early the moment a wire is seen: a Mercury payroll wire (wire-detected) for this
// period or sent after the submit, a confirmed wire in Gusto, or Gusto's "wire received" email.
// READ-ONLY: never moves money, never touches Gusto. Message strings follow the house COMMS_STYLE.

import { getJson, setJson } from "@/lib/kv";
import { humanize } from "@/lib/salesos/outreach";
import { appUrl, type BotCard } from "@/lib/notify/aiBots";
import { DISPLAY_TZ, opsLocalInputToIso, shiftYmd, ymdInTz } from "@/lib/dates";
import { listGustoSubmitResults, readGustoConfirmWireResult, type GustoSubmitResult } from "./gustoSubmitState";
import { listWireEvents, formatUsd, type WireEventRecord } from "./wireEvent";
import { postPayrollCard } from "./slack";

const STATE_KEY = "payroll.wireReminders";
const FIRST_AFTER_MS = 2 * 60 * 60 * 1000;
const SECOND_AT_HOUR = 10; // ET, the day after the submit
/** Submits older than this are never reminded about (covers the next-day reminder with room to spare,
 *  and keeps a deploy from nagging about old payrolls). */
const WINDOW_MS = 48 * 60 * 60 * 1000;
/** A wire sent a little before the submit still counts (the team sometimes wires first). */
const WIRE_LEAD_MS = 12 * 60 * 60 * 1000;

export interface ReminderState {
  sent: number; // reminders posted for this period (0..2)
  lastAt: string | null;
}
type ReminderStore = Record<string, ReminderState>;

/** True when a wire for this payroll has been seen. Pure. */
export function wireSeenFor(submit: GustoSubmitResult, wires: WireEventRecord[], wireConfirmedInGusto: boolean): boolean {
  if (wireConfirmedInGusto) return true;
  const submittedMs = Date.parse(submit.at);
  return wires.some((w) => {
    if (w.status === "failed") return false;
    if (w.receiptConfirmed) {
      const r = Date.parse(w.receiptConfirmedAt ?? "");
      if (Number.isFinite(r) && r >= submittedMs - WIRE_LEAD_MS) return true;
    }
    const mp = w.matchedPeriod;
    if (mp && mp.periodStart === submit.periodStart && mp.periodEnd === submit.periodEnd) return true;
    const seen = Date.parse(w.createdAt ?? w.firstSeenAt);
    return Number.isFinite(seen) && seen >= submittedMs - WIRE_LEAD_MS;
  });
}

/** When reminder n (1 or 2) becomes due for a submit made at `submittedAt`. Pure. */
export function reminderDueAt(submittedAt: string, n: 1 | 2): number {
  const at = Date.parse(submittedAt);
  if (n === 1) return at + FIRST_AFTER_MS;
  const nextDay = shiftYmd(ymdInTz(DISPLAY_TZ, new Date(at)), 1);
  const iso = opsLocalInputToIso(`${nextDay}T${String(SECOND_AT_HOUR).padStart(2, "0")}:00`);
  return Math.max(iso ? Date.parse(iso) : at + 24 * 60 * 60 * 1000, at + FIRST_AFTER_MS);
}

/** Which reminder (if any) to post now. Pure. */
export function reminderToSend(
  submit: GustoSubmitResult,
  state: ReminderState | null,
  wireSeen: boolean,
  now: number,
): 1 | 2 | null {
  if (!submit.ok || !submit.submitted) return null;
  if (wireSeen) return null;
  const at = Date.parse(submit.at);
  if (!Number.isFinite(at) || now - at > WINDOW_MS) return null;
  const sent = state?.sent ?? 0;
  if (sent >= 2) return null;
  const n = (sent + 1) as 1 | 2;
  return now >= reminderDueAt(submit.at, n) ? n : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDay(ymd: string | null): string | null {
  const m = ymd ? /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd) : null;
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : null;
}
export function periodLabelOf(s: GustoSubmitResult): string {
  const a = shortDay(s.periodStart);
  const b = shortDay(s.periodEnd);
  return a && b ? `${a} to ${b}` : "this week";
}
function etTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: DISPLAY_TZ, weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** The reminder card. Pure. */
export function wireReminderCard(submit: GustoSubmitResult, n: 1 | 2): BotCard {
  const period = periodLabelOf(submit);
  const amount = submit.expectedTotal != null ? formatUsd(submit.expectedTotal) : null;
  const lead = n === 1 ? "" : "Second reminder. ";
  const body = humanize(
    `${lead}Payroll for the ${period} pay period was submitted in Gusto ${etTime(submit.at)} ET, but no wire to Gusto has shown up from Mercury yet.` +
      ` Please send the wire${amount ? ` (about ${amount})` : ""} so payroll is funded on time.`,
  );
  return {
    title: n === 1 ? "Payroll wire not sent yet" : "Payroll wire still not sent",
    fields: [
      { label: "Pay period", value: period },
      { label: "Submitted", value: `${etTime(submit.at)} ET` },
      ...(amount ? [{ label: "Expected wire", value: amount }] : []),
    ],
    body,
    link: { text: "Open payroll", url: appUrl("/payroll") },
    context: n === 1
      ? "Payroll Bot. One more reminder at 10am tomorrow if the wire is still missing. Stops as soon as Mercury reports the wire."
      : "Payroll Bot. Last reminder for this payroll.",
  };
}

/** Runtime-clock tick. Never throws. */
export async function runWireReminderTick(now: number = Date.now()): Promise<{ ok: boolean; detail: string }> {
  try {
    const recent = listGustoSubmitResults(10).filter((s) => s.ok && s.submitted && now - Date.parse(s.at) <= WINDOW_MS);
    if (!recent.length) return { ok: true, detail: "no payroll submitted in the last 2 days" };
    const wires = listWireEvents(50);
    const store = getJson<ReminderStore>(STATE_KEY, {});
    const notes: string[] = [];
    let changed = false;
    for (const s of recent) {
      const confirmed = readGustoConfirmWireResult(s.key);
      const seen = wireSeenFor(s, wires, !!(confirmed?.ok && confirmed.confirmed));
      const n = reminderToSend(s, store[s.key] ?? null, seen, now);
      const label = periodLabelOf(s);
      if (seen) { notes.push(`${label}: wire seen`); continue; }
      if (!n) { notes.push(`${label}: waiting (${store[s.key]?.sent ?? 0} sent)`); continue; }
      const res = await postPayrollCard(wireReminderCard(s, n), `wire-reminder:${s.key}:${n}`);
      if (res.ok) {
        store[s.key] = { sent: n, lastAt: new Date(now).toISOString() };
        changed = true;
        notes.push(`${label}: reminder ${n} posted`);
      } else {
        notes.push(`${label}: reminder ${n} post failed`);
      }
    }
    if (changed) setJson(STATE_KEY, store);
    return { ok: true, detail: notes.join("; ") };
  } catch (e) {
    return { ok: false, detail: `wire reminder failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
