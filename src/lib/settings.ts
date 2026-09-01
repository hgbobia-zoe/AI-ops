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
  /** Customer "on the way" text. */
  onWay: string;
  /** Customer "arrived" text. */
  arrived: string;
  /** Day-of coordinator "on the way" text. */
  coordinatorOnWay: string;
  /** Day-of coordinator "arrived" text. */
  coordinatorArrived: string;
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
    },
  };
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
  // Drop lines with a still-empty {link}; collapse the resulting triple newlines.
  out = out
    .split("\n")
    .filter((line) => !line.includes("{link}"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out;
}
