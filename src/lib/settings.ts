// Team-editable configuration — the "customize outside of code" layer.
//
// Everything here has a sensible DEFAULT derived from the environment / current
// behavior, and an optional OVERRIDE stored in the DB (settings table, one JSON row).
// So the app behaves exactly as before until someone edits it in /admin, and the team
// can change message wording, the Ignition link, truck mappings, etc. without a deploy.
//
// Server-only (touches the DB via better-sqlite3). Read with getSettings(); write with
// saveSettings(). Not imported by any client component.

import { getDb } from "@/lib/db";

export interface MessageTemplates {
  // Delivery (drop-off) texts.
  /** Customer "on the way" text. */
  onWay: string;
  /** Customer "arrived" text. */
  arrived: string;
  /** Day-of coordinator "on the way" text. */
  coordinatorOnWay: string;
  /** Day-of coordinator "arrived" text. */
  coordinatorArrived: string;
  // Pickup (collection) texts — used when the stop's kind is "pickup".
  onWayPickup: string;
  arrivedPickup: string;
  coordinatorOnWayPickup: string;
  coordinatorArrivedPickup: string;
}

export interface AppSettings {
  companyName: string;
  /** IANA timezone for human-facing times. */
  timezone: string;
  /** Zonar number that ETA-link notifications go to — must be the company line, never
   *  a customer's (Zonar texts this number). Shown in admin; the tablet uses its own
   *  build-time copy for the native ETA mint. */
  notifyPhone: string;
  /** Ignition (Zonar) URL shown in the dispatch pane / native board mode. */
  ignitionUrl: string;
  /** Per-truck static Zonar ETA-link URLs (truckId → url). */
  ignitionEtaLinks: Record<string, string>;
  /** Per-truck Zonar unit ids, for minting live ETA links (truckId → unitId). */
  ignitionUnits: Record<string, number>;
  templates: MessageTemplates;
  /** Active integration providers (see src/lib/providers.ts). */
  smsProvider: string;
  gpsProvider: string;
  /** Per-truck vehicle id in the active GPS provider (truckId → provider vehicle id).
   *  Used by server-side GPS providers (Samsara/Motive); Zonar uses ignitionUnits. */
  gpsVehicleIds: Record<string, string>;
  /** AI Org employees an operator has PAUSED (list of agent ids). A paused agent proposes nothing and
   *  shows as paused in the org chart. This is an operational on/off switch — it does NOT edit the
   *  code-reviewed employee config. Owner/admin only; toggled from the org chart tile detail panel. */
  aiPaused: string[];
  /** Operational Opportunity detection — the "tomorrow's prep window" rule (see event/prepOpportunity.ts).
   *  Admin-tunable; conservative, honest defaults. All times are MINUTES unless noted. */
  prepOpportunity: PrepOpportunitySettings;
  /** Item names (case-insensitive substrings) that make a route "specialty / harder", so the driver
   *  auto-router puts SENIOR drivers on specialty routes and newer drivers on easier ones when routes start
   *  at the same time (see scheduling/routeSpecialty.ts). Tents are ALWAYS specialty (crewRules), so this
   *  list EXTENDS that built-in rule — it never needs "tent" in it. */
  specialtyItemKeywords: string[];
  /** Goodshuffle line-item names (case-insensitive substrings) that mark a stop as a PREMIUM / exact-time
   *  arrival window, so the driver debrief adds the "mind the stop timings" reminder (see
   *  scheduling/packetDispatch.ts). Default matches the real Zoe products (all carry "arrival window"). */
  premiumWindowKeywords: string[];
  /** Line-item names (case-insensitive substrings) that mark a stop as having the Event Readiness Service,
   *  so the debrief names that customer for setup (see scheduling/packetDispatch.ts). */
  eventReadinessKeywords: string[];
  /** Optional override for the NON-FINANCIAL "current operating year" boundary (see
   *  dates.ts:currentOperatingYearStart). A bare year ("2026") or a full date ("2026-01-01"); null/unset
   *  means "compute Jan 1 of the current year dynamically". Financial paths ignore this entirely. */
  operatingYearStart: string | null;
}

export interface PrepOpportunitySettings {
  /** Base minutes to prep & load ANY delivery truck, before size scaling. */
  loadBaseMinutes: number;
  /** Added minutes per stop on the route (size proxy). */
  loadMinutesPerStop: number;
  /** Added minutes per line-item across the route (finer size proxy). */
  loadMinutesPerItem: number;
  /** When remaining in-shift slack ≤ this, the window is THREATENED (closing), not a comfortable rec. */
  threatenedMinutes: number;
  /** Optional backstop: the local hour (0–23) the warehouse hard-closes; null = rely on crew shift-ends. */
  warehouseCloseHour: number | null;
  /** OT policy. "in_shift_only" (safe default) = never recommend loading past scheduled shift-end. A
   *  future "flag_needs_approval" mode would surface OT as a needs-approval action rather than suppress it. */
  otPolicy: "in_shift_only";
}

// The variables a template may reference, with a short description for the admin UI.
export const TEMPLATE_VARS: { token: string; desc: string }[] = [
  { token: "{firstName}", desc: "Customer's first name (coordinator's, on coordinator texts)" },
  { token: "{custName}", desc: "Customer / event name" },
  { token: "{company}", desc: "Your company name" },
  { token: "{truck}", desc: "Truck name" },
  { token: "{address}", desc: "Delivery address" },
  { token: "{eta}", desc: "Estimated arrival time" },
  { token: "{window}", desc: "Delivery window" },
  { token: "{link}", desc: "Live tracking link (its line is dropped if there's no link)" },
];

function envUnits(): Record<string, number> {
  // Mirror the fallback in kioskBridge so admin shows the real starting values.
  const defaults: Record<string, number> = { E450: 200149627, "NPR-1": 200149626, "NPR-2": 200214102 };
  try {
    const map = JSON.parse(process.env.NEXT_PUBLIC_IGNITION_UNITS_JSON || "{}") as Record<string, number>;
    return { ...defaults, ...map };
  } catch {
    return defaults;
  }
}

function envJson<T>(raw: string | undefined, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** The out-of-the-box settings — current behavior, sourced from the environment. */
export function defaultSettings(): AppSettings {
  return {
    companyName: process.env.COMPANY_NAME || "Zoe Events",
    timezone: process.env.ETA_TIMEZONE || "America/New_York",
    notifyPhone: process.env.ETA_NOTIFY_PHONE || "301-291-5296",
    ignitionUrl: process.env.IGNITION_URL || "",
    ignitionEtaLinks: envJson<Record<string, string>>(process.env.IGNITION_ETALINK_JSON, {}),
    ignitionUnits: envUnits(),
    templates: {
      onWay:
        "Hi {firstName},\n\n" +
        "This is just a quick update regarding your delivery. Our team is en route and will be arriving at your location within the next hour. Please ensure someone is available to receive your rentals.\n\n" +
        "You can check the latest location here: {link}\n\n" +
        "Thank you!",
      arrived:
        "Hi {firstName}, your {company} delivery team has arrived. We'll begin unloading shortly. Thank you!",
      coordinatorOnWay:
        "Hi {firstName},\n\n" +
        "{company} here — our delivery team is en route to {custName} and will arrive within the next hour. You're listed as the day-of coordinator.\n\n" +
        "Latest location: {link}\n\n" +
        "Thank you!",
      coordinatorArrived:
        "Hi {firstName}, {company} has arrived at {custName}. We'll begin unloading shortly.",
      onWayPickup:
        "Hi {firstName},\n\n" +
        "Just a quick update — our team is on the way to pick up your rentals and will arrive within the next hour. Please have the items gathered and accessible.\n\n" +
        "You can check the latest location here: {link}\n\n" +
        "Thank you!",
      arrivedPickup:
        "Hi {firstName}, your {company} team has arrived to pick up your rentals. Thank you!",
      coordinatorOnWayPickup:
        "Hi {firstName},\n\n" +
        "{company} here — our team is en route to {custName} to pick up the rentals and will arrive within the next hour. You're listed as the day-of coordinator.\n\n" +
        "Latest location: {link}\n\n" +
        "Thank you!",
      coordinatorArrivedPickup:
        "Hi {firstName}, {company} has arrived at {custName} to pick up the rentals.",
    },
    smsProvider: process.env.SMS_PROVIDER || "openphone",
    gpsProvider: process.env.GPS_PROVIDER || "zonar",
    gpsVehicleIds: {},
    aiPaused: [],
    prepOpportunity: {
      loadBaseMinutes: numEnv(process.env.PREP_LOAD_BASE_MIN, 45),
      loadMinutesPerStop: numEnv(process.env.PREP_LOAD_PER_STOP_MIN, 10),
      loadMinutesPerItem: numEnv(process.env.PREP_LOAD_PER_ITEM_MIN, 1),
      threatenedMinutes: numEnv(process.env.PREP_THREATENED_MIN, 45),
      warehouseCloseHour: process.env.PREP_WAREHOUSE_CLOSE_HOUR ? numEnv(process.env.PREP_WAREHOUSE_CLOSE_HOUR, 0) : null,
      otPolicy: "in_shift_only",
    },
    specialtyItemKeywords: envJson<string[]>(process.env.SPECIALTY_ITEM_KEYWORDS, DEFAULT_SPECIALTY_KEYWORDS),
    premiumWindowKeywords: envJson<string[]>(process.env.PREMIUM_WINDOW_KEYWORDS, DEFAULT_PREMIUM_WINDOW_KEYWORDS),
    eventReadinessKeywords: envJson<string[]>(process.env.EVENT_READINESS_KEYWORDS, DEFAULT_EVENT_READINESS_KEYWORDS),
    operatingYearStart: process.env.OPERATING_YEAR_START || null,
  };
}

/** Out-of-the-box premium / exact-time arrival-window line items (the real Zoe Goodshuffle products all
 *  carry "arrival window"; the others are backups if the wording shifts). The team edits this in /admin. */
export const DEFAULT_PREMIUM_WINDOW_KEYWORDS: string[] = ["arrival window", "premium time", "exact time", "elite hour"];

/** Out-of-the-box Event Readiness Service line-item match. The team edits this in /admin. */
export const DEFAULT_EVENT_READINESS_KEYWORDS: string[] = ["event readiness"];

/** Out-of-the-box "specialty / harder" item keywords (beyond tents, which crewRules always flags). Chosen
 *  to be conservative event-rental signals of a harder load; the team edits this list in /admin. */
export const DEFAULT_SPECIALTY_KEYWORDS: string[] = [
  "dance floor",
  "staging",
  "stage",
  "subfloor",
  "flooring",
  "chandelier",
  "draping",
  "truss",
  "lighting",
  "generator",
];

/** Parse a numeric env var, falling back to `fallback` when unset/invalid. */
function numEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Pick the delivery or pickup wording for a template slot, based on the stop's kind
 *  (defaults to delivery when unknown — the original behavior). */
export function templateForKind(
  t: MessageTemplates,
  kind: "delivery" | "pickup" | undefined,
  slot: "onWay" | "arrived" | "coordinatorOnWay" | "coordinatorArrived",
): string {
  const pickup = kind === "pickup";
  switch (slot) {
    case "onWay":
      return pickup ? t.onWayPickup : t.onWay;
    case "arrived":
      return pickup ? t.arrivedPickup : t.arrived;
    case "coordinatorOnWay":
      return pickup ? t.coordinatorOnWayPickup : t.coordinatorOnWay;
    case "coordinatorArrived":
      return pickup ? t.coordinatorArrivedPickup : t.coordinatorArrived;
  }
}

// Deep-merge a stored partial over the defaults so newly-added fields keep working on
// an old saved row. Objects merge one level (templates / the id maps); scalars replace.
function merge(base: AppSettings, over: Partial<AppSettings> | null): AppSettings {
  if (!over) return base;
  return {
    ...base,
    ...over,
    templates: { ...base.templates, ...(over.templates ?? {}) },
    ignitionEtaLinks: over.ignitionEtaLinks ?? base.ignitionEtaLinks,
    ignitionUnits: over.ignitionUnits ?? base.ignitionUnits,
    gpsVehicleIds: over.gpsVehicleIds ?? base.gpsVehicleIds,
    prepOpportunity: { ...base.prepOpportunity, ...(over.prepOpportunity ?? {}) },
    specialtyItemKeywords: over.specialtyItemKeywords ?? base.specialtyItemKeywords,
    premiumWindowKeywords: over.premiumWindowKeywords ?? base.premiumWindowKeywords,
    eventReadinessKeywords: over.eventReadinessKeywords ?? base.eventReadinessKeywords,
  };
}

const KEY = "app";

/** Current settings: DB overrides merged over the environment defaults. */
export function getSettings(): AppSettings {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as
    | { value: string }
    | undefined;
  let stored: Partial<AppSettings> | null = null;
  if (row) {
    try {
      stored = JSON.parse(row.value) as Partial<AppSettings>;
    } catch {
      stored = null;
    }
  }
  return merge(defaultSettings(), stored);
}

/** Persist a full settings object (already merged by the caller). */
export function saveSettings(next: AppSettings): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(KEY, JSON.stringify(next), new Date().toISOString());
}

/**
 * Fill a message template. Unknown tokens are left as-is; any LINE that still contains
 * an unfilled {link} after substitution is dropped (so "Track here: {link}" vanishes
 * when there's no link), and the blank gap it leaves is collapsed.
 */
export function renderTemplate(tpl: string, vars: Record<string, string | undefined>): string {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) {
    if (v == null) continue;
    out = out.split(`{${k}}`).join(v);
  }
  // Drop lines with a still-unfilled optional placeholder ({link}, {timingNote}); collapse the resulting
  // triple newlines. These are the templates' conditional lines — absent token means the line isn't wanted.
  out = out
    .split("\n")
    .filter((line) => !line.includes("{link}") && !line.includes("{timingNote}") && !line.includes("{readinessNote}") && !line.includes("{clockLine}"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out;
}
