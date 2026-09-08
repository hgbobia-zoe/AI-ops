// Sales Trends — deterministic win/loss cuts by SEASON, EVENT TYPE, and AREA. RULES CALCULATE from
// real outcomes. Event type is INFERRED from the event name (Goodshuffle has no category field) and is
// labelled as such in the UI — an inference, not a fact. Area is parsed from Goodshuffle's location.

import { outcomeOf } from "./lost";

export interface TrendInput {
  signed: boolean;
  statusLabel?: string | null;
  grandTotal?: number | null;
  eventDate?: string | null; // YYYY-MM-DD
  eventName?: string | null;
  location?: string | null; // cityStateZipCounty
  items?: string[] | null; // captured line-item titles (strong event-type signal when present)
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const sum = (a: number[]): number | null => (a.length ? a.reduce((s, v) => s + v, 0) : null);

export interface MonthTrend {
  month: number; // 1–12
  label: string;
  won: number;
  lost: number;
  decided: number;
  winRate: number | null;
  revenue: number | null; // won $ (booked revenue) in that month across years
}

/** Win/loss + booked revenue by calendar month, aggregated across all years — the seasonality view. */
export function seasonTrends(deals: TrendInput[]): MonthTrend[] {
  const buckets = MONTHS.map((label, i) => ({ month: i + 1, label, won: 0, lost: 0, wonVals: [] as number[] }));
  for (const d of deals) {
    if (!d.eventDate || d.eventDate.length < 7) continue;
    const m = Number(d.eventDate.slice(5, 7)) - 1;
    if (m < 0 || m > 11) continue;
    const o = outcomeOf(d);
    if (o === "open") continue;
    const b = buckets[m];
    if (o === "won") {
      b.won++;
      if (typeof d.grandTotal === "number") b.wonVals.push(d.grandTotal);
    } else b.lost++;
  }
  return buckets.map((b) => {
    const decided = b.won + b.lost;
    return { month: b.month, label: b.label, won: b.won, lost: b.lost, decided, winRate: decided > 0 ? b.won / decided : null, revenue: sum(b.wonVals) };
  });
}

export type EventType = "wedding" | "corporate" | "social" | "other";

export const EVENT_TYPE_LABEL: Record<EventType, string> = {
  wedding: "Weddings",
  corporate: "Corporate",
  social: "Social / private",
  other: "Other / unclassified",
};

const WEDDING_RE = /\b(wedding|bride|groom|nuptial|ceremony|reception|engagement|elopement)\b/i;
const CORPORATE_RE = /\b(corp|company|gala|conference|conf|meeting|office|fundraiser|non[- ]?profit|nonprofit|launch|summit|expo|holiday party|award|retreat|seminar|networking|inc\.?|llc|association|chamber)\b/i;
const SOCIAL_RE = /\b(birthday|b-?day|anniversary|graduation|grad|shower|quincea|mitzvah|reunion|party|celebration|sweet 16|sweet sixteen|baptism|christening|funeral|memorial|festival|picnic|cookout|bbq)\b/i;

/** Infer the event type from its name. Order matters: wedding, then corporate, then social. An honest
 *  guess from free text — the UI must label it as inferred. */
export function classifyEventType(name?: string | null): EventType {
  const n = (name ?? "").toLowerCase();
  if (WEDDING_RE.test(n)) return "wedding";
  if (CORPORATE_RE.test(n)) return "corporate";
  if (SOCIAL_RE.test(n)) return "social";
  return "other";
}

// Distinctive line-item signals — far stronger evidence than an address-y event name.
// NB: "drape" alone is ambiguous — "pipe and drape" is corporate staging — so wedding uses only "draping".
const ITEM_WEDDING = /\b(arch|arbor|aisle|chuppah|sweetheart|chiavari|charger|draping|dance ?floor|gold chair|champagne wall|backdrop)\b/i;
const ITEM_CORPORATE = /\b(podium|lectern|stage|staging|projector|screen|pipe and drape|highboy|cocktail table|conference|trade ?show|booth|barricade)\b/i;
const ITEM_SOCIAL = /\b(bounce|inflatable|balloon|cotton candy|popcorn|concession|kids|carnival|photo ?booth|dunk)\b/i;

export interface EventClassification {
  type: EventType;
  confidence: number; // 0..1
  verified: boolean; // true when a distinctive signal supports it (not just a generic name/items)
  evidence: string; // what the classification rests on
}

/** Classify an event using the best available evidence: distinctive LINE ITEMS first (strong), then the
 *  event name (moderate), else Unverified. Never overstates — generic items (just tables/chairs) stay
 *  Unverified. */
export function classifyEvent(name?: string | null, items?: string[] | null): EventClassification {
  const itemText = (items ?? []).join(" ").toLowerCase();
  if (itemText) {
    if (ITEM_WEDDING.test(itemText)) return { type: "wedding", confidence: 0.85, verified: true, evidence: "wedding-specific rentals" };
    if (ITEM_CORPORATE.test(itemText)) return { type: "corporate", confidence: 0.8, verified: true, evidence: "corporate/AV rentals" };
    if (ITEM_SOCIAL.test(itemText)) return { type: "social", confidence: 0.8, verified: true, evidence: "party/kids rentals" };
  }
  const byName = classifyEventType(name);
  if (byName !== "other") return { type: byName, confidence: 0.6, verified: true, evidence: "event name" };
  return { type: "other", confidence: 0.25, verified: false, evidence: (items ?? []).length ? "generic rentals only" : "no distinctive signal" };
}

export interface TypeTrend {
  type: EventType;
  label: string;
  won: number;
  lost: number;
  decided: number;
  winRate: number | null;
  avgWonValue: number | null;
}

/** Win/loss by inferred event type. */
export function typeTrends(deals: TrendInput[]): TypeTrend[] {
  const types: EventType[] = ["wedding", "corporate", "social", "other"];
  return types.map((type) => {
    const inType = deals.filter((d) => classifyEvent(d.eventName, d.items).type === type && outcomeOf(d) !== "open");
    const won = inType.filter((d) => outcomeOf(d) === "won");
    const lost = inType.filter((d) => outcomeOf(d) === "lost");
    const decided = won.length + lost.length;
    const wonVals = won.map((d) => d.grandTotal).filter((v): v is number => typeof v === "number");
    return {
      type,
      label: EVENT_TYPE_LABEL[type],
      won: won.length,
      lost: lost.length,
      decided,
      winRate: decided > 0 ? won.length / decided : null,
      avgWonValue: wonVals.length ? wonVals.reduce((s, v) => s + v, 0) / wonVals.length : null,
    };
  });
}

export type Region = "DC" | "MD" | "VA" | "Other";

/** Parse a DMV region from Goodshuffle's location string. Conservative — only clear DC/MD/VA signals. */
export function regionOf(location?: string | null): Region {
  const s = (location ?? "").toLowerCase();
  if (!s) return "Other";
  if (/\b(d\.?c\.?|district of columbia|washington,\s*dc)\b/.test(s)) return "DC";
  if (/\b(md|maryland)\b/.test(s)) return "MD";
  if (/\b(va|virginia)\b/.test(s)) return "VA";
  return "Other";
}

export interface AreaTrend {
  region: Region;
  won: number;
  lost: number;
  decided: number;
  winRate: number | null;
  revenue: number | null;
}

/** Win/loss + booked revenue by DMV region. */
export function areaTrends(deals: TrendInput[]): AreaTrend[] {
  const regions: Region[] = ["DC", "MD", "VA", "Other"];
  return regions.map((region) => {
    const inR = deals.filter((d) => regionOf(d.location) === region && outcomeOf(d) !== "open");
    const won = inR.filter((d) => outcomeOf(d) === "won");
    const lost = inR.filter((d) => outcomeOf(d) === "lost");
    const decided = won.length + lost.length;
    const wonVals = won.map((d) => d.grandTotal).filter((v): v is number => typeof v === "number");
    return { region, won: won.length, lost: lost.length, decided, winRate: decided > 0 ? won.length / decided : null, revenue: sum(wonVals) };
  });
}
