// Guided Sales Intake — deterministic formatting. Turns the structured intake into (a) a suggested
// Goodshuffle project name and (b) a readable internal-notes block stashed on the project shell, so every
// captured fact travels to Goodshuffle even before the rename/date/contact writes are wired. No inference:
// UNKNOWN and UNANSWERED are rendered as themselves, never as No.

import type { Intake, TriState } from "./types";
import type { GeoResult } from "./geocode";

// The delivery-location payload carried in the create_project op. The drainer uses it two ways: to set the
// project venue (saveDefaultEventLocation) and to embed the address+coords in each logistics leg's add
// payload (Goodshuffle requires that, or it rejects delivery items with "Delivery Location Missing").
export interface GsLocation {
  venueName: string;
  address: string;
  line2: string;
  city: string;
  county: string;
  state: string;
  zip: string;
  country: string;
  latitude: string;
  longitude: string;
}

/** Build the delivery-location payload from the intake plus a successful geocode. Returns null when there's
 *  no usable street address or the geocode failed — the caller then skips the location-dependent auto-adds. */
export function gsIntakeLocation(i: Intake, geo: GeoResult | null): GsLocation | null {
  if (!geo || !i.streetAddress.trim()) return null;
  return {
    venueName: i.venueName.trim() || i.streetAddress.trim(),
    address: i.streetAddress.trim(),
    line2: "",
    city: i.city.trim(),
    county: geo.county,
    state: i.state.trim(),
    zip: i.zip.trim(),
    country: "US",
    latitude: geo.latitude,
    longitude: geo.longitude,
  };
}

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
const LOCATION_CLASS_LABEL: Record<string, string> = { residential: "Residential", commercial: "Commercial (office building)", venue: "Venue" };
// The three delivery types (standard = flexible day-before with the free 9AM–8PM window; premium/exact
// are same-day paid windows). Built into a single "Delivery timing" note line with any captured target time.
const DELIVERY_TYPE_META: Record<string, { label: string; window: string; price: string }> = {
  standard: { label: "Flexible (day before / pickup day after)", window: "9AM–8PM", price: "no charge" },
  premium: { label: "Premium window", window: "same-day 2-hour", price: "+$100" },
  exact: { label: "Exact time", window: "same-day 30-minute", price: "+$150" },
};
function deliveryTimingLine(i: Intake): string {
  const m = DELIVERY_TYPE_META[i.deliveryTier];
  if (!m) return i.deliveryTier || "Not set";
  const time = i.deliveryTier !== "standard" && i.deliveryTime ? ` · target ${gsTime(i.deliveryTime) || i.deliveryTime}` : "";
  return `${m.label} · ${m.window} · ${m.price}${time}`;
}

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
    `Guests: ${guests(i)}`,
    `Date: ${i.eventDate || "Not set"}`,
    `Time: ${i.eventStartTime || "—"}${i.eventEndTime ? ` to ${i.eventEndTime}` : ""}`,
    "",
    "-- LOCATION --",
    `Venue: ${i.venueName || "—"}`,
    `Address: ${addr || "—"}`,
    `Setting: ${LOCATION_CLASS_LABEL[i.locationClass] ?? "Not set"}`,
    ...(i.locationClass === "commercial" ? ["⚠ COMMERCIAL / OFFICE — deliver within business hours only (weekdays ~9am–5pm). Confirm someone will be on site to receive."] : []),
    "",
    "-- LOGISTICS --",
    `Delivery: ${tri(i.deliveryRequired)}`,
    ...(i.deliveryTier ? [`Delivery timing: ${deliveryTimingLine(i)}`] : []),
    `Setup help: ${tri(i.setupRequired)}`,
    `Breakdown help: ${tri(i.pickupRequired)}`,
    ...(access.length ? ["Access:", ...access.map((x) => `  • ${x}`)] : []),
    ...(i.logisticsNotes.trim() ? ["", `Logistics notes: ${i.logisticsNotes.trim()}`] : []),
    ...(i.salesNotes.trim() ? ["", "-- SALES NOTES --", i.salesNotes.trim()] : []),
    "",
    "NOTE: rental inventory to be added in Goodshuffle. This shell was created from the guided sales intake.",
  ];
  return lines.filter((l) => l !== null && l !== undefined).join("\n");
}
