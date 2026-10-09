// The 3-touch shift-comms TEMPLATE system (not hardcoded message strings). Each touch is a named
// template of {tokens}, rendered from the structured ShiftPacket through the same renderTemplate the
// customer SMS templates use (settings.ts). Touches:
//   on_assign   — full packet, fired on reaching PROVISIONED
//   day_before  — full packet again (start - ~16h)
//   refresher   — the essentials + the delivery-route link, start - ~45m
// House comms style (comms-no-dashes memory rule): no em-dashes, no emoji, short, natural. A null fact
// renders as "TBD" (never a guess). The {link} line (refresher only) is dropped by renderTemplate when
// no link is minted. The warehouse address + cul-de-sac note are literal in the copy, not tokens.

import { renderTemplate } from "@/lib/settings";
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
    "Delivery route details: {link}\n" +
    "Questions {dispatch}.",
};

function orTbd(v: string | null | undefined): string {
  return v && v.trim() ? v : "TBD";
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

/** Build the token map for a packet. Null facts become "TBD" (honest). {link} is refresher-only and
 *  dropped by renderTemplate when null. */
function packetVars(p: ShiftPacket, link: string | null): Record<string, string | undefined> {
  return {
    name: orTbd(p.assignment.displayName),
    role: ROLE_WORD[p.identity.role],
    date: p.identity.date,
    reportTime: orTbd(p.reporting.reportTime),
    truck: orTbd(p.assignment.truck?.name ?? null),
    crew: crewPhrase(p.assignment.coworkers),
    clockLine: clockLine(p.timekeeping),
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
