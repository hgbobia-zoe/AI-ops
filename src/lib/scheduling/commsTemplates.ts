// The 3-touch shift-comms TEMPLATE system (not hardcoded message strings). Each touch is a named
// template of {tokens}, rendered from the structured ShiftPacket through the same renderTemplate the
// customer SMS templates use (settings.ts). Touches:
//   on_assign   — full packet, fired on reaching PROVISIONED
//   day_before  — full packet again (start - ~16h)
//   refresher   — the essentials only (report time/place/truck/supervisor), start - ~45m
// House comms style (comms-no-dashes memory rule): no em-dashes, no emoji, short, natural. A null fact
// renders as "TBD" (never a guess). A missing {link} line is dropped by renderTemplate.

import { renderTemplate } from "@/lib/settings";
import type { ShiftPacket } from "./packet";

export type CommsTouch = "on_assign" | "day_before" | "refresher";

const ROLE_WORD: Record<ShiftPacket["identity"]["role"], string> = { driver: "driver", field: "field crew", prep: "warehouse prep" };

/** Default templates. Overridable later via settings (same pattern as customer SMS), kept here as the
 *  deterministic floor so a packet always renders without any configuration. */
export const SHIFT_COMMS_TEMPLATES: Record<CommsTouch, string> = {
  on_assign:
    "Hi {name}, you are booked as {role} on {date} for {event}.\n" +
    "Report {reportTime} at {reportLocation}.\n" +
    "Truck {truck}. Lead {supervisor}.\n" +
    "Bring/load: {equipment}.\n" +
    "{instructions}\n" +
    "Clock in: {clockIn}\n" +
    "Questions: {dispatch}\n" +
    "{link}",
  day_before:
    "Reminder for tomorrow {date}: {role} for {event}.\n" +
    "Report {reportTime} at {reportLocation}. Truck {truck}. Lead {supervisor}.\n" +
    "Clock in: {clockIn}\n" +
    "Questions: {dispatch}\n" +
    "{link}",
  refresher:
    "Shift soon: {role} for {event}. Report {reportTime} at {reportLocation}. Truck {truck}. Lead {supervisor}. Questions {dispatch}.\n" +
    "{link}",
};

function orTbd(v: string | null | undefined): string {
  return v && v.trim() ? v : "TBD";
}

/** Build the token map for a packet. Null facts become "TBD" (honest), lists become readable phrases. */
function packetVars(p: ShiftPacket, link: string | null): Record<string, string | undefined> {
  return {
    name: orTbd(p.assignment.displayName),
    role: ROLE_WORD[p.identity.role],
    date: p.identity.date,
    event: orTbd(p.identity.eventLabel),
    reportTime: orTbd(p.reporting.reportTime),
    reportLocation: orTbd(p.reporting.reportLocation),
    truck: orTbd(p.assignment.truck?.name ?? null),
    supervisor: orTbd(p.assignment.supervisor?.name ?? null),
    equipment: p.operations.equipment.length ? p.operations.equipment.join(", ") : "nothing extra",
    instructions: p.operations.instructions ?? "",
    clockIn: p.timekeeping.howTo,
    dispatch: p.dispatch.phone,
    link: link ? `View your packet: ${link}` : undefined,
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
