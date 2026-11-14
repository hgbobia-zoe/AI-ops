// Guided Sales Intake — deterministic formatting. Turns the structured intake into (a) a suggested
// Goodshuffle project name, (b) the saveEventDetails field set, (c) the client-contact payload, and (d) a
// readable internal-notes block stashed on the project shell, so every captured fact travels to Goodshuffle.
// The name/date, venue, client contact, and notes writes are all wired and verified live (2026-10-31). No
// inference: UNKNOWN and UNANSWERED are rendered as themselves, never as No.

import type { Intake, TriState } from "./types";
import type { GeoResult } from "./geocode";
import { isEliteHour, isSunday, WINDOW_PRICE_PER_LEG } from "@/lib/salesos/salesRules";
import { legTiers, missingUpgradeLegs } from "./gsItems";

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

// ── Goodshuffle client contact (POST /app/contact/saveNewContact — captured + verified live 2026-10-31) ──
// Creates the client contact AND attaches it to the project in one call (the transactionID in the body is
// what links it). The drainer builds the full form body; this just carries the customer fields the intake
// captured. Returns null when the intake has no name and no way to reach the customer (then the shell is
// created with the contact info still present in the internal notes, and the client is added by hand).
export interface GsClient {
  firstName: string;
  lastName: string;
  email: string;
  mobilePhone: string;
}

export function gsClientContact(i: Intake): GsClient | null {
  const firstName = i.firstName.trim();
  const lastName = i.lastName.trim();
  const email = i.email.trim();
  const mobilePhone = i.phone.trim();
  if (!firstName && !lastName && !email && !mobilePhone) return null;
  return { firstName, lastName, email, mobilePhone };
}

const EVENT_TYPE_LABEL: Record<string, string> = { wedding: "Wedding", corporate: "Corporate", social: "Social / Private", other: "Other" };
const LOCATION_CLASS_LABEL: Record<string, string> = { residential: "Residential", commercial: "Commercial (office building)", venue: "Venue" };
// The three delivery types (standard = flexible day-before with the free 9AM–8PM window; premium/exact
// are same-day paid windows). Built into a single "Delivery timing" note line with any captured target time.
const DELIVERY_TYPE_META: Record<string, { label: string; window: string; price: string }> = {
  standard: { label: "Flexible (day before / pickup day after)", window: "9AM–8PM", price: "no charge" },
  premium: { label: "Premium window", window: "same-day 2-hour", price: "+$100 per leg" },
  exact: { label: "Exact time", window: "same-day 30-minute", price: "+$150 per leg" },
};
// Same-day window from a START time + the option's duration (premium 2h / exact 30m): "10:00 AM–12:00 PM".
function deliveryWindow(hhmm: string, tier: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return "";
  const mins = tier === "exact" ? 30 : 120;
  let t = (Number(m[1]) * 60 + Number(m[2]) + mins) % 1440;
  if (t < 0) t += 1440;
  const end = `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  return `${gsTime(hhmm)}–${gsTime(end)}`;
}
// One leg's window, priced per timed leg (owner, 2026-11-14).
const LEG_META: Record<string, { label: string; price: string }> = {
  standard: { label: "Standard 9AM–8PM", price: "no charge" },
  premium: { label: "Premium 2-hour window", price: `+$${WINDOW_PRICE_PER_LEG.premium}` },
  exact: { label: "Exact 30-minute window", price: `+$${WINDOW_PRICE_PER_LEG.exact}` },
  elite: { label: "Elite Hour (after 10 PM)", price: `+$${WINDOW_PRICE_PER_LEG.elite}` },
};
function legLine(name: string, tier: string, time: string): string {
  const m = LEG_META[tier];
  if (!m) return `${name}: not set`;
  if (tier === "standard") return `${name}: ${m.label}, ${m.price}`;
  const win = time ? (tier === "elite" ? gsTime(time) : deliveryWindow(time, tier)) : "time not set";
  return `${name}: ${m.label} ${win}, ${m.price}`;
}
function deliveryTimingLine(i: Intake): string {
  if (i.deliveryFlexible === "yes" || (i.deliveryTier === "standard" && !i.dropoffTier && !i.pickupTier)) {
    const m = DELIVERY_TYPE_META.standard;
    return `${m.label} · ${m.window} · ${m.price}`;
  }
  const t = legTiers(i);
  if (!t.drop && !t.pick) return i.deliveryTier || "Not set";
  return `${legLine("Drop-off", t.drop, i.dropoffTime)} · ${legLine("Pick-up", t.pick, i.pickupTime)} (timed legs are their own line items)`;
}
function hasDeliveryTiming(i: Intake): boolean {
  return !!(i.deliveryTier || i.dropoffTier || i.pickupTier);
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

/** The Goodshuffle project name. Follows GSPRO's own default convention — "LastName - Street Address"
 *  (e.g. "Singh - 8684 Wales Ct") — so created projects read the same as ones made in GSPRO by hand;
 *  GSPRO appends the "(#id)" itself. Falls back gracefully when the last name or address is missing. */
export function suggestEventName(i: Intake): string {
  const last = i.lastName.trim() || i.firstName.trim() || "New customer";
  const addr = i.streetAddress.trim();
  return addr ? `${last} - ${addr}` : last;
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
    ...(isSunday(i.eventDate) ? ["SUNDAY: an exception only, no surcharge. Hermann or Cindy gives the final yes before we confirm."] : []),
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
    ...(hasDeliveryTiming(i) ? [`Delivery timing: ${deliveryTimingLine(i)}`] : []),
    ...eliteNotes(i),
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

/** Elite Hour lines for the notes (owner, 2026-11-14: +$200 per leg after 10 PM). An Elite leg with no
 *  Goodshuffle item configured must be added by hand; a Premium or Exact time at 10 PM or later is really an
 *  Elite Hour leg, so the rep should check it. */
function eliteNotes(i: Intake): string[] {
  const out: string[] = [];
  const missing = missingUpgradeLegs(i);
  const names = { dropoff: "drop-off", pickup: "pick-up" } as const;
  for (const leg of missing) out.push(`ELITE HOUR: add the Elite Hour line by hand for the ${names[leg]}, +$${WINDOW_PRICE_PER_LEG.elite}.`);
  const t = legTiers(i);
  const late = [
    t.drop !== "elite" && isEliteHour(i.dropoffTime) ? "drop-off" : "",
    t.pick !== "elite" && isEliteHour(i.pickupTime) ? "pick-up" : "",
  ].filter(Boolean);
  if (late.length) out.push(`ELITE HOUR: the ${late.join(" and ")} is after 10 PM, which is Elite Hour (+$${WINDOW_PRICE_PER_LEG.elite} per leg). Check the window.`);
  return out;
}
