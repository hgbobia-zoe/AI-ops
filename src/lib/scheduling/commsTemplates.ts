// The shift-comms TEMPLATE system (not hardcoded message strings). Each touch is a named template of
// {tokens}, rendered from the structured ShiftPacket through the same renderTemplate the customer SMS
// templates use (settings.ts). Touches:
//   on_assign   — full packet (manual dispatcher send only)
//   day_before  — full packet again (manual dispatcher send only)
//   refresher   — the essentials + the delivery-route link; THIS is the single AUTO debrief, sent ~2h
//                 before the shift to route crew only (see workerPackets.ts dueTouches)
// The auto trigger fires ONLY "refresher". on_assign / day_before remain available for a human to send by
// hand from the dispatcher, and renderAllTouches still previews all three.
// House comms style (comms-no-dashes memory rule): no em-dashes, no emoji, short, natural. A null fact
// renders as "TBD" (never a guess). Times render in Eastern (reportTimePhrase → "9:30 AM ET") and dates
// long ("Thu, Oct 23") — never a raw ISO instant. The {link} line (refresher only) is dropped by
// renderTemplate when no link is minted. The warehouse address + cul-de-sac note are literal, not tokens.

import { renderTemplate } from "@/lib/settings";
import { formatYmdLong, formatClockTime } from "@/lib/dates";
import type { ShiftPacket } from "./packet";

export type CommsTouch = "on_assign" | "day_before" | "refresher";

/** The worker's OWN duty word. driver→driver, field→delivery helper, prep→warehouse prep. */
export const ROLE_WORD: Record<ShiftPacket["identity"]["role"], string> = {
  driver: "driver",
  field: "delivery helper",
  prep: "warehouse prep",
};

/** Default templates. Overridable later via settings (same pattern as customer SMS), kept here as the
 *  deterministic floor so a packet always renders without any configuration. Only the refresher carries
 *  the {link} line; the other two touches have no link line at all. */
export const SHIFT_COMMS_TEMPLATES: Record<CommsTouch, string> = {
  on_assign:
    "Hi {name}, you're booked as {role} on {date}.\n" +
    "Report {reportTime} at the warehouse: 12712 Rock Creek Mill Rd, Unit 4A. We're on the lower end of the building, at the end of the cul-de-sac.\n" +
    "Truck: {truck}.\n" +
    "Working with: {crew}.\n" +
    "{clockLine}\n" +
    "Questions: {dispatch}",
  day_before:
    "Reminder for tomorrow {date}: {role}.\n" +
    "Report {reportTime} at the warehouse: 12712 Rock Creek Mill Rd, Unit 4A (lower end of the building, end of the cul-de-sac).\n" +
    "Truck: {truck}.\n" +
    "Working with: {crew}.\n" +
    "{clockLine}\n" +
    "Questions: {dispatch}",
  refresher:
    "Shift soon: {role}. Report {reportTime} at the warehouse: 12712 Rock Creek Mill Rd, Unit 4A (lower end, end of the cul-de-sac). Truck: {truck}.\n" +
    "Working with: {crew}.\n" +
    "{clockLine}\n" +
    "{timingNote}\n" +
    "Delivery route details: {link}\n" +
    "Questions {dispatch}.",
};

function orTbd(v: string | null | undefined): string {
  return v && v.trim() ? v : "TBD";
}

/** A readable report time in Eastern (e.g. "9:30 AM ET"). An ISO instant is formatted to ET clock time with
 *  an "ET" suffix so no one reads a raw "2026-10-23T13:30:00.000Z"; free-text values ("morning") pass
 *  through unchanged; null → "TBD". */
function reportTimePhrase(v: string | null | undefined): string {
  if (!v || !v.trim()) return "TBD";
  const formatted = formatClockTime(v);
  return formatted && formatted !== v.trim() ? `${formatted} ET` : formatted;
}

/** The crew phrase: the OTHER live assignees, each "Name (their-own-role word)", comma-joined. None → "just you". */
function crewPhrase(coworkers: ShiftPacket["assignment"]["coworkers"]): string {
  if (!coworkers.length) return "just you";
  return coworkers.map((c) => `${orTbd(c.name)} (${ROLE_WORD[c.role]})`).join(", ");
}

/** The clock-in/out line, by worker kind. Internal → Connecteam personal code. Instawork → the gig's
 *  per-gig codes when captured, else the honest app fallback (never fabricate a code). */
function clockLine(tk: ShiftPacket["timekeeping"]): string {
  if (tk.kind === "internal") return "Clock in/out on Connecteam with your personal code.";
  if (tk.clockInCode && tk.clockOutCode) return `Clock in: ${tk.clockInCode}. Clock out: ${tk.clockOutCode}.`;
  return "Clock in/out through the Instawork app.";
}

/** The time-sensitive reminder, included ONLY when the route has stops with a specific delivery window
 *  (route.timedStops > 0). Tells the driver to learn the stop timings and mind arrival/departure so the
 *  paid-for service windows are met. Returns undefined when nothing is time-sensitive, so the template line
 *  drops (renderTemplate drops the unfilled {timingNote} line, same as {link}). */
function timingNotePhrase(route: ShiftPacket["operations"]["route"]): string | undefined {
  if (!route || route.timedStops <= 0) return undefined;
  return "Heads up, this route has time sensitive stops. Get familiar with the stop timings and mind your arrival and departure times so we deliver the services the customers paid for.";
}

/** Build the token map for a packet. Null facts become "TBD" (honest). {link} is refresher-only and
 *  dropped by renderTemplate when null. */
function packetVars(p: ShiftPacket, link: string | null): Record<string, string | undefined> {
  return {
    name: orTbd(p.assignment.displayName),
    role: ROLE_WORD[p.identity.role],
    date: formatYmdLong(p.identity.date),
    reportTime: reportTimePhrase(p.reporting.reportTime),
    truck: orTbd(p.assignment.truck?.name ?? null),
    crew: crewPhrase(p.assignment.coworkers),
    clockLine: clockLine(p.timekeeping),
    timingNote: timingNotePhrase(p.operations.route),
    dispatch: p.dispatch.phone,
    link: link ?? undefined,
  };
}

/** Render one touch's message from the packet. Pure + deterministic. */
export function renderPacketTouch(packet: ShiftPacket, touch: CommsTouch, link: string | null = null): string {
  return renderTemplate(SHIFT_COMMS_TEMPLATES[touch], packetVars(packet, link));
}

/** Render all three touches (for the dispatcher preview). */
export function renderAllTouches(packet: ShiftPacket, link: string | null = null): Record<CommsTouch, string> {
  return {
    on_assign: renderPacketTouch(packet, "on_assign", link),
    day_before: renderPacketTouch(packet, "day_before", link),
    refresher: renderPacketTouch(packet, "refresher", link),
  };
}
