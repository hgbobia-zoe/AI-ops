// Address review — flag stops at a business / office with restricted hours so a truck
// doesn't roll up while nobody's there (it happened: a commercial stop, closed on
// arrival). Deterministic + free; runs on every route (import time → Slack, dispatch
// board → badge). The LLM can refine it later, but keywords catch the common cases.
//
// Three classes:
//   • "venue"       — hotel/ballroom/club/barn/etc. Events happen there off-hours BY
//                     DESIGN, so we do NOT flag these even on a weekend evening.
//   • "business"    — office / suite / corporate park / school. Restricted hours →
//                     flag, and flag LOUDER when the stop is scheduled outside them.
//   • "residential" — house/apartment. No hours risk.

import { DISPLAY_TZ } from "./dates";

export type AddressClass = "business" | "venue" | "residential";

export interface AddressReview {
  class: AddressClass;
  /** True for a business address scheduled outside typical open hours (the real risk). */
  hoursRisk: boolean;
  /** Short reasons (matched signals) for the tooltip / Slack detail. */
  signals: string[];
  /** One-line human note for the badge / alert. */
  note: string;
}

// Event venues that legitimately operate evenings/weekends — never flagged as "closed".
const VENUE = /\b(hotel|inn|resort|lodge|club|ballroom|banquet|hall|manor|estate|mansion|château|chateau|villa|museum|gallery|winery|vineyard|brewery|barn|farm|ranch|orchard|garden(?:s)?|conservatory|country club|golf|marina|yacht|arena|stadium|pavilion|amphitheater|theater|theatre|chapel|cathedral|synagogue|temple|event\s*(?:space|center|venue)|conference\s*center)\b/i;

// Office / commercial signals with restricted (roughly 9–5, Mon–Fri) hours.
const BUSINESS =
  /\b(suite|ste\.?|unit\s*\d|floor|\bfl\.?\s*\d|\bbldg\b|building|tower|plaza|centre|corporate|business\s*park|office|\bllc\b|\binc\.?\b|\bltd\b|\bco\.?\b|\bcorp\b|company|dealership|showroom|warehouse|distribution|industrial|campus|school|academy|university|college|clinic|hospital|medical|dental|law\s*(?:firm|office)|bank|studio|salon|store|shop|market|mall|restaurant|cafe|café)\b/i;

// Residential hints (bias away from "business" for a bare apartment).
const RESIDENTIAL = /\b(apt\.?|apartment|#\s*\d+[a-z]?$|residence|home)\b/i;

/** Business open-hours window used for the risk check (local ops time). */
const OPEN_HOUR = Number(process.env.BUSINESS_OPEN_HOUR || 9); // 9 AM
const CLOSE_HOUR = Number(process.env.BUSINESS_CLOSE_HOUR || 17); // 5 PM

/** Weekday (0=Sun..6=Sat) and hour (0-23) of an ISO instant in the ops timezone. */
function opsWeekdayHour(iso?: string): { weekday: number; hour: number } | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DISPLAY_TZ,
    weekday: "short",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date(t));
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "";
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = map[wd];
  let hour = Number(hourStr);
  if (hour === 24) hour = 0; // some environments render midnight as 24
  if (weekday === undefined || Number.isNaN(hour)) return null;
  return { weekday, hour };
}

function classify(text: string): { cls: AddressClass; signals: string[] } {
  const signals: string[] = [];
  const venue = text.match(VENUE);
  if (venue) return { cls: "venue", signals: [venue[0].toLowerCase()] };
  const biz = text.match(BUSINESS);
  const res = text.match(RESIDENTIAL);
  // A bare "Apt 4B" is residential even though "unit/#" could look business-y.
  if (biz && !(res && !/\b(suite|ste|office|corporate|building|bldg|tower|plaza|business\s*park|llc|inc|corp|company|campus|school)\b/i.test(text))) {
    signals.push(biz[0].toLowerCase());
    return { cls: "business", signals };
  }
  if (res) return { cls: "residential", signals: [res[0].toLowerCase()] };
  return { cls: "residential", signals: [] };
}

/**
 * Review one stop's address. `name` (customer/venue label) is checked too — venue names
 * often live there, not in the street address. `whenIso` is the stop's scheduled time,
 * used to decide whether a business is being hit outside its open hours.
 */
export function reviewStopAddress(input: {
  address?: string;
  name?: string;
  whenIso?: string;
}): AddressReview {
  const hay = `${input.name ?? ""} ${input.address ?? ""}`.trim();
  const { cls, signals } = classify(hay);

  if (cls !== "business") {
    return { class: cls, hoursRisk: false, signals, note: cls === "venue" ? "Event venue" : "Residential" };
  }

  const wh = opsWeekdayHour(input.whenIso);
  let hoursRisk = false;
  let when = "";
  if (wh) {
    const weekend = wh.weekday === 0 || wh.weekday === 6;
    const outside = wh.hour < OPEN_HOUR || wh.hour >= CLOSE_HOUR;
    hoursRisk = weekend || outside;
    if (weekend) when = " — scheduled on a weekend, office likely closed";
    else if (outside) when = ` — scheduled outside ${OPEN_HOUR}–${CLOSE_HOUR}, office may be closed`;
  }
  return {
    class: "business",
    hoursRisk,
    signals,
    note: hoursRisk
      ? `Business address${when}. Confirm someone will be there.`
      : "Business address — confirm access hours.",
  };
}
