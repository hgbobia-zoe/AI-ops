// Guided Sales Intake — deterministic formatting. Turns the structured intake into (a) a suggested
// Goodshuffle project name and (b) a readable internal-notes block stashed on the project shell, so every
// captured fact travels to Goodshuffle even before the rename/date/contact writes are wired. No inference:
// UNKNOWN and UNANSWERED are rendered as themselves, never as No.

import type { Intake, TriState } from "./types";

// ── Goodshuffle saveEventDetails formats (captured live on a TEST project) ──────────────────────────
// POST /app/vendorTransaction/saveEventDetails (form-encoded): transactionID, eventName, fromDateStr,
// fromTimeStr, toDateStr, toTimeStr, eventType, headCount. Dates are "MMM D YYYY" ("Sep 25 2026"); times
// are "h:mm AM/PM" ("3:00 PM"); eventType is the Goodshuffle label ("Wedding"); headCount is a plain number.
const GS_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const GS_EVENT_TYPE: Record<string, string> = { wedding: "Wedding", corporate: "Corporate" }; // only labels confirmed to exist; others left blank

export function gsDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || "");
  if (!m) return "";
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return "";
  return `${GS_MONTHS[mo - 1]} ${Number(m[3])} ${m[1]}`;
}
export function gsTime(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return "";
  let h = Number(m[1]);
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${m[2]} ${ap}`;
}

/** The saveEventDetails field set for a new project shell, from the intake. Single-day event (to = from).
 *  Fields we can't map cleanly (an event type outside the confirmed list) are left blank, never guessed. */
export function gsEventDetails(i: Intake): Record<string, string> {
  const d = gsDate(i.eventDate);
  return {
    eventName: suggestEventName(i),
    fromDateStr: d,
    fromTimeStr: gsTime(i.eventStartTime),
    toDateStr: d,
    toTimeStr: gsTime(i.eventEndTime),
    eventType: GS_EVENT_TYPE[i.eventType] ?? "",
    headCount: i.guestCount != null ? String(i.guestCount) : "",
  };
}

const EVENT_TYPE_LABEL: Record<string, string> = { wedding: "Wedding", corporate: "Corporate", social: "Social / Private", other: "Other" };
const LOCATION_TYPE_LABEL: Record<string, string> = { residential: "Residential", venue: "Event venue", hotel: "Hotel", corporate: "Corporate / Office", school: "School", park: "Park / Public space", other: "Other" };

export function eventTypeLabel(i: Intake): string {
  if (i.eventType === "other") return i.eventTypeOther.trim() || "Other";
  return EVENT_TYPE_LABEL[i.eventType] ?? "Event";
}

function tri(v: TriState): string {
  return v === "yes" ? "Yes" : v === "no" ? "No" : v === "not_sure" ? "Not sure" : "Not asked";
}

function guests(i: Intake): string {
  if (i.guestCount != null) return String(i.guestCount);
  if (i.guestCountUnknown) return "Unknown (customer didn't know)";
  return "Not asked";
}

/** A human-readable project name suggestion: "First Last · Wedding · 2027-06-20". Internal ops label
 *  (not customer-facing), used as the notes header until the GS rename endpoint is wired. */
export function suggestEventName(i: Intake): string {
  const who = [i.firstName.trim(), i.lastName.trim()].filter(Boolean).join(" ") || "New customer";
  const parts = [who, eventTypeLabel(i)];
  if (i.eventDate) parts.push(i.eventDate);
  return parts.join(" · ");
}

/** The internal-notes block stashed on the Goodshuffle project shell. Every captured fact, honestly. */
export function formatIntakeNotes(i: Intake): string {
  const addr = [i.streetAddress, [i.city, i.state].filter(Boolean).join(", "), i.zip].filter((x) => x && x.trim()).join(", ");
  const access: string[] = [];
  const a = i.accessNotes;
  const pushIf = (label: string, v: TriState | undefined): void => { if (v) access.push(`${label}: ${tri(v)}`); };
  pushIf("Stairs", a.stairs);
  pushIf("Elevator", a.elevator);
  pushIf("Loading dock", a.loadingDock);
  pushIf("Access restrictions", a.accessRestrictions);
  pushIf("Long carry (truck→setup)", a.longCarry);
  pushIf("Parking restrictions", a.parkingRestrictions);
  if (a.deliveryWindow && a.deliveryWindow.trim()) access.push(`Required delivery window: ${a.deliveryWindow.trim()}`);
  if (a.crewNotes && a.crewNotes.trim()) access.push(`For the crew: ${a.crewNotes.trim()}`);

  const lines: string[] = [
    "=== ZOE SALES INTAKE (guided) ===",
    `Suggested name: ${suggestEventName(i)}`,
    i.createdBy ? `Captured by: ${i.createdBy}` : "",
    "",
    "-- CUSTOMER --",
    `Name: ${[i.firstName, i.lastName].filter(Boolean).join(" ") || "—"}`,
    `Phone: ${i.phone || "—"}`,
    `Email: ${i.email || "—"}`,
    "",
    "-- EVENT --",
    `Type: ${eventTypeLabel(i)}`,
    `Setting: ${i.customerType === "commercial" ? "Commercial" : i.customerType === "residential" ? "Residential" : "Not set"}`,
    `Guests: ${guests(i)}`,
    `Date: ${i.eventDate || "Not set"}`,
    `Time: ${i.eventStartTime || "—"}${i.eventEndTime ? ` to ${i.eventEndTime}` : ""}`,
    "",
    "-- LOCATION --",
    `Venue: ${i.venueName || "—"}`,
    `Address: ${addr || "—"}`,
    `Location type: ${LOCATION_TYPE_LABEL[i.locationType] ?? "Not set"}`,
    "",
    "-- LOGISTICS --",
    `Delivery: ${tri(i.deliveryRequired)}`,
    `Setup: ${tri(i.setupRequired)}`,
    `Pickup: ${tri(i.pickupRequired)}`,
    ...(access.length ? ["Access:", ...access.map((x) => `  • ${x}`)] : []),
    ...(i.logisticsNotes.trim() ? ["", `Logistics notes: ${i.logisticsNotes.trim()}`] : []),
    ...(i.salesNotes.trim() ? ["", "-- SALES NOTES --", i.salesNotes.trim()] : []),
    "",
    "NOTE: rental inventory to be added in Goodshuffle. This shell was created from the guided sales intake.",
  ];
  return lines.filter((l) => l !== null && l !== undefined).join("\n");
}
