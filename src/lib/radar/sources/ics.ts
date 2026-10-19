// Event Radar — ICS / iCal event-feed source (the first WORKING authorized EVENT source).
//
// Every live source wired before this one is PROCUREMENT (SAM.gov, the county/city browser workflows).
// Events only ever came from the demo seed or a manual CSV paste. This adapter closes that gap: it reads
// a PUBLISHED calendar feed (the iCalendar/.ics format that convention centres, universities, civic and
// Localist-powered venue calendars commonly expose for subscription) and turns each VEVENT into a
// normalized, deduplicated radar event — the exact shape the existing pipeline (ingest.ts → store.ts)
// already consumes. No paid API, no key, no scraping of a page that didn't offer a feed.
//
// Design law — "RULES CALCULATE. AI INTERPRETS." Parsing here is PURE and deterministic; it never
// fabricates a fact. Attendance stays UNKNOWN (a calendar never states it), a public listing is recorded
// as NOT_YET_VERIFIED (a signal, not proof a rental is up for grabs), and rental attributes are only
// marked PRESENT when their keyword literally appears in the event's own text. Unknown stays unknown.
//
// Dormant until configured: with no RADAR_ICS_FEEDS set, icsFeedsFromEnv() returns [] and the Sources
// registry shows the ICS source as REQUIRED_MISSING — the exact, documented blocker. The moment one or
// more public feed URLs are configured, server-side pulls (/api/radar/events/pull, the Sources "Run"
// button, the radar cron) populate real events.

import { shiftYmd } from "@/lib/dates";
import type { RawEventRecord } from "../ingest";
import { normalizeCategory } from "../ingest";
import type { Attributes, AttributeKey } from "../types";
import type { EventSource } from "../ingest";

// ── Feed configuration ──────────────────────────────────────────────────────────────────────────
export interface IcsFeedConfig {
  id: string; // stable source id, used as the radar_source id and in the dedupe key
  name: string; // human label shown in the Sources registry
  url: string; // the public .ics feed URL
  region?: string; // optional hint for the Sources registry only (geography is derived from LOCATION)
}

/** Parse the RADAR_ICS_FEEDS env into feed configs. Accepts either a JSON array of objects, or a
 *  newline / comma separated list where each entry is a bare URL or "Name | url | region". Never throws;
 *  a malformed entry is skipped. */
export function icsFeedsFromEnv(raw: string | undefined = process.env.RADAR_ICS_FEEDS): IcsFeedConfig[] {
  if (!raw || !raw.trim()) return [];
  const trimmed = raw.trim();
  // JSON array form.
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed) as unknown[];
      return arr
        .map((x, i) => coerceFeed(x, i))
        .filter((f): f is IcsFeedConfig => f !== null);
    } catch {
      return [];
    }
  }
  // Delimited list form.
  return trimmed
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry, i) => {
      const parts = entry.split("|").map((p) => p.trim());
      if (parts.length >= 2) return makeFeed(parts[1], parts[0], parts[2], i);
      return makeFeed(parts[0], undefined, undefined, i);
    })
    .filter((f): f is IcsFeedConfig => f !== null);
}

function coerceFeed(x: unknown, i: number): IcsFeedConfig | null {
  if (typeof x === "string") return makeFeed(x, undefined, undefined, i);
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    const url = typeof o.url === "string" ? o.url : null;
    if (!url) return null;
    return makeFeed(url, typeof o.name === "string" ? o.name : undefined, typeof o.region === "string" ? o.region : undefined, i, typeof o.id === "string" ? o.id : undefined);
  }
  return null;
}

function makeFeed(url: string | undefined, name: string | undefined, region: string | undefined, i: number, id?: string): IcsFeedConfig | null {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  let host = "feed";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* keep default */ }
  return {
    id: id || `ics:${slugHost(host)}-${i + 1}`,
    name: name || `Event calendar (${host})`,
    url,
    region,
  };
}

function slugHost(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export function icsFeedsConfigured(): boolean {
  return icsFeedsFromEnv().length > 0;
}

// ── ICS parsing (PURE, no dependencies) ───────────────────────────────────────────────────────────
export interface ParsedVEvent {
  uid: string | null;
  summary: string | null;
  description: string | null;
  location: string | null;
  url: string | null;
  organizer: string | null; // the ORGANIZER CN (common name), when present
  dtStart: string | null; // raw value
  dtStartIsDate: boolean;
  dtEnd: string | null; // raw value
  dtEndIsDate: boolean;
}

/** Unfold RFC 5545 folded lines: a CRLF (or LF) followed by a space or tab continues the prior line. */
function unfold(text: string): string[] {
  const rawLines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of rawLines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** Unescape iCal TEXT values (\n, \N, \, \; \, and literal backslash). */
function unescapeText(v: string): string {
  return v.replace(/\\([nN,;\\])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c)).trim();
}

/** Split a property line into { name, params, value } on the first unescaped ':'. */
function parseLine(line: string): { name: string; params: string; value: string } | null {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const semi = left.indexOf(";");
  const name = (semi < 0 ? left : left.slice(0, semi)).trim().toUpperCase();
  const params = semi < 0 ? "" : left.slice(semi + 1);
  return { name, params, value };
}

/** Read a named parameter (e.g. CN, VALUE, TZID) out of a property's param segment. */
function getParam(params: string, key: string): string | null {
  const re = new RegExp(`(?:^|;)${key}=([^;]*)`, "i");
  const m = params.match(re);
  if (!m) return null;
  return m[1].replace(/^"|"$/g, "");
}

/** Parse every VEVENT in an ICS document. Deterministic; ignores anything outside VEVENT blocks. */
export function parseIcs(text: string): ParsedVEvent[] {
  if (!text || !/BEGIN:VEVENT/i.test(text)) return [];
  const lines = unfold(text);
  const events: ParsedVEvent[] = [];
  let cur: ParsedVEvent | null = null;
  for (const line of lines) {
    const u = line.trim().toUpperCase();
    if (u === "BEGIN:VEVENT") {
      cur = { uid: null, summary: null, description: null, location: null, url: null, organizer: null, dtStart: null, dtStartIsDate: false, dtEnd: null, dtEndIsDate: false };
      continue;
    }
    if (u === "END:VEVENT") {
      if (cur) events.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const p = parseLine(line);
    if (!p) continue;
    switch (p.name) {
      case "UID": cur.uid = p.value.trim() || null; break;
      case "SUMMARY": cur.summary = unescapeText(p.value) || null; break;
      case "DESCRIPTION": cur.description = unescapeText(p.value) || null; break;
      case "LOCATION": cur.location = unescapeText(p.value) || null; break;
      case "URL": cur.url = p.value.trim() || null; break;
      case "ORGANIZER": cur.organizer = getParam(p.params, "CN"); break;
      case "DTSTART":
        cur.dtStart = p.value.trim() || null;
        cur.dtStartIsDate = /DATE/i.test(getParam(p.params, "VALUE") ?? "") || /^\d{8}$/.test(p.value.trim());
        break;
      case "DTEND":
        cur.dtEnd = p.value.trim() || null;
        cur.dtEndIsDate = /DATE/i.test(getParam(p.params, "VALUE") ?? "") || /^\d{8}$/.test(p.value.trim());
        break;
      default: break;
    }
  }
  return events;
}

/** Normalize an ICS date/datetime value to YYYY-MM-DD, or null when unparseable. */
export function icsDateToYmd(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const month = Number(mo), day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${mo}-${d}`;
}

// ── LOCATION → venue / city / state (best-effort, honest about unknowns) ───────────────────────────
const STATE_RE = /\b(MD|DC|VA|Maryland|Virginia|District of Columbia|Washington,?\s*D\.?C\.?)\b/i;

export function splitLocation(loc: string | null): { venue: string | null; city: string | null; state: string | null } {
  if (!loc || !loc.trim()) return { venue: null, city: null, state: null };
  // Strip a trailing ZIP so it doesn't pollute the city token.
  const cleaned = loc.replace(/\s+\d{5}(?:-\d{4})?\b/, "").trim();
  const parts = cleaned.split(",").map((p) => p.trim()).filter(Boolean);
  let state: string | null = null;
  const stateMatch = cleaned.match(STATE_RE);
  if (stateMatch) {
    const s = stateMatch[1].toUpperCase();
    state = s.startsWith("MARYLAND") ? "MD" : s.startsWith("VIRGINIA") ? "VA" : s.startsWith("DISTRICT") || s.startsWith("WASHINGTON") ? "DC" : s;
  }
  // A single token: it's a venue/name, not enough to call a city.
  if (parts.length === 1) return { venue: parts[0], city: null, state };
  // "Venue, City, ST" style → venue first, city is the part before the state (or the second part).
  const venue = parts[0];
  let city: string | null = null;
  for (let i = 1; i < parts.length; i++) {
    if (STATE_RE.test(parts[i]) && !/^[A-Za-z .]+,/.test(parts[i])) {
      city = i > 1 ? parts[i - 1] : parts[1];
      break;
    }
  }
  if (!city && parts.length >= 2) city = parts[1];
  return { venue, city, state };
}

// ── Deterministic rental-attribute inference (keyword-present → PRESENT only; never ABSENT) ────────
const ATTRIBUTE_KEYWORDS: { key: AttributeKey; re: RegExp }[] = [
  { key: "reception", re: /\breception\b/i },
  { key: "gala", re: /\b(gala|awards dinner|black[- ]?tie)\b/i },
  { key: "exhibitors", re: /\bexhibit|expo\s*floor|trade\s*show/i },
  { key: "networking", re: /\bnetworking\b/i },
  { key: "outdoor", re: /\b(outdoor|lawn|courtyard|waterfront|tent|rooftop|garden)\b/i },
  { key: "hospitality", re: /\bhospitality\b/i },
  { key: "vip", re: /\bvip\b/i },
  { key: "sponsor_activation", re: /\b(sponsor activation|sponsor booth|activation)\b/i },
  { key: "virtual", re: /\b(virtual|online only|webinar|livestream only)\b/i },
];

export function deriveAttributesFromText(text: string): Attributes {
  const attrs: Attributes = {};
  for (const { key, re } of ATTRIBUTE_KEYWORDS) {
    if (re.test(text)) attrs[key] = "PRESENT";
  }
  return attrs;
}

// ── VEVENT → RawEventRecord ─────────────────────────────────────────────────────────────────────
/** Map one parsed VEVENT to a RawEventRecord. Returns null when there is no usable name — we never
 *  store a nameless placeholder. Attendance is always UNKNOWN (a calendar never states it). */
export function veventToRaw(v: ParsedVEvent, feed: IcsFeedConfig): RawEventRecord | null {
  const name = v.summary?.trim();
  if (!name) return null;

  const startDate = icsDateToYmd(v.dtStart);
  let endDate = icsDateToYmd(v.dtEnd);
  // RFC 5545: an all-day DTEND is EXCLUSIVE (the morning after the last day) — pull it back one day so a
  // single-day all-day event is not mistaken for multi-day.
  if (endDate && v.dtEndIsDate) endDate = shiftYmd(endDate, -1);
  if (endDate && startDate && endDate <= startDate) endDate = null;

  const text = `${name} ${v.description ?? ""}`;
  const { venue, city, state } = splitLocation(v.location);

  return {
    externalId: v.uid ? `ics:${v.uid}` : undefined, // stable UID → same event across re-pulls → dedup
    name,
    description: v.description ?? undefined,
    category: normalizeCategory(text),
    startDate: startDate ?? null,
    endDate: endDate ?? null,
    venue: venue ?? undefined,
    city: city ?? undefined,
    state: state ?? undefined,
    sourceUrl: v.url ?? feed.url,
    expectedAttendance: null, // a calendar never states attendance — stay honest
    attendanceConfidence: "UNKNOWN",
    // A public listing is a SIGNAL, not proof a rental contract exists — record it as unverified.
    verificationStatus: "NOT_YET_VERIFIED",
    attributes: deriveAttributesFromText(text),
    organization: v.organizer ? { name: v.organizer, verificationStatus: "INFERRED" } : undefined,
  };
}

/** Parse an ICS document into RawEventRecords for a feed. Pure — the network lives in icsEventSource. */
export function icsTextToRecords(text: string, feed: IcsFeedConfig): RawEventRecord[] {
  return parseIcs(text)
    .map((v) => veventToRaw(v, feed))
    .filter((r): r is RawEventRecord => r !== null);
}

// ── EventSource builders ──────────────────────────────────────────────────────────────────────────
/** Build an EventSource that fetches and parses a live ICS feed. discover() THROWS on a fetch / HTTP
 *  failure so the pipeline records the source as ERROR (= unavailable / stale), which the Sources UI
 *  surfaces. An empty or malformed-but-reachable feed yields [] (no events, not an error). */
export function icsEventSource(feed: IcsFeedConfig, fetchImpl: typeof fetch = fetch): EventSource {
  return {
    id: feed.id,
    name: feed.name,
    kind: "ICS_FEED",
    region: feed.region,
    adapter: "ics",
    isSeed: false,
    async discover(): Promise<RawEventRecord[]> {
      const res = await fetchImpl(feed.url, {
        signal: AbortSignal.timeout(25_000),
        headers: { Accept: "text/calendar, text/plain, */*" },
      });
      if (!res.ok) throw new Error(`feed returned HTTP ${res.status}`);
      const text = await res.text();
      return icsTextToRecords(text, feed);
    },
  };
}

/** Build an EventSource from ICS text already in hand (a browser-agent POST, or a test). No network. */
export function icsEventSourceFromText(feed: IcsFeedConfig, text: string): EventSource {
  return {
    id: feed.id,
    name: feed.name,
    kind: "ICS_FEED",
    region: feed.region,
    adapter: "ics",
    isSeed: false,
    discover: () => icsTextToRecords(text, feed),
  };
}

/** The configured ICS feeds as EventSources (empty when dormant). */
export function configuredIcsSources(): EventSource[] {
  return icsFeedsFromEnv().map((f) => icsEventSource(f));
}
