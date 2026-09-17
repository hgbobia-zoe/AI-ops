// Event Radar — seed / DEMO data. Everything here is marked is_seed=1 so the UI can badge it "SEED"
// and it can NEVER be mistaken for verified production data. The set is small but realistic and
// deliberately exercises every path: verified / inferred / unknown planners, a recurring series whose
// next instance is ANNOUNCED, a recurring series whose next is only PREDICTED/UNANNOUNCED, and the
// negative signals (out-of-area, fully virtual). Dates are explicit (relative to a 2026 "today") so
// timing phases are meaningful. No planner, attendance or contact here is invented beyond a plainly
// fictional demo dataset — and it's labelled as such throughout.
//
// It also registers a few real DMV SOURCES as disabled/never-run stubs, to show the ingestion registry
// is ready for a real fetcher to be wired to each (adapter=null = not yet implemented).

import { getEventCount, upsertSource } from "./store";
import { runSource, type EventSource, type RawEventRecord } from "./ingest";

const SEED_EVENTS: RawEventRecord[] = [
  // ── CHD Conference — recurring, NEXT ALREADY ANNOUNCED (2027 is a real instance) ──────────────
  {
    externalId: "chd-2027",
    name: "CHD Conference 2027",
    description: "National congenital heart disease clinical conference — sessions, exhibit hall, and an evening reception.",
    category: "Medical conference",
    startDate: "2027-09-17",
    endDate: "2027-09-19",
    venue: "Grand Hyatt Washington",
    address: "1000 H St NW",
    city: "Washington",
    state: "DC",
    sourceUrl: "https://example-demo.org/chd-2027",
    expectedAttendance: 900,
    attendanceConfidence: "INFERRED",
    verificationStatus: "INFERRED",
    attributes: { reception: "PRESENT", exhibitors: "PRESENT", networking: "PRESENT", outdoor: "UNKNOWN", virtual: "ABSENT" },
    organization: { name: "Congenital Heart Disease Alliance", website: "https://example-demo.org", orgType: "NONPROFIT", verificationStatus: "INFERRED" },
    series: { key: "chd-conference", name: "CHD Conference", cadence: "ANNUAL", recurrenceConfidence: "HIGH" },
    // Planner deliberately UNKNOWN → detail shows "RESEARCH ORGANIZER" (matches the brief's example).
  },
  { externalId: "chd-2026", name: "CHD Conference 2026", category: "Medical conference", startDate: "2026-09-12", endDate: "2026-09-14", venue: "Marriott Marquis", city: "Washington", state: "DC", expectedAttendance: 850, attendanceConfidence: "VERIFIED", verificationStatus: "VERIFIED", attributes: { reception: "PRESENT", exhibitors: "PRESENT" }, organization: { name: "Congenital Heart Disease Alliance", orgType: "NONPROFIT", verificationStatus: "INFERRED" }, series: { key: "chd-conference", name: "CHD Conference", cadence: "ANNUAL", recurrenceConfidence: "HIGH" } },
  { externalId: "chd-2025", name: "CHD Conference 2025", category: "Medical conference", startDate: "2025-09-13", venue: "Grand Hyatt Washington", city: "Washington", state: "DC", expectedAttendance: 800, attendanceConfidence: "VERIFIED", verificationStatus: "VERIFIED", series: { key: "chd-conference", name: "CHD Conference", cadence: "ANNUAL", recurrenceConfidence: "HIGH" } },
  { externalId: "chd-2024", name: "CHD Conference 2024", category: "Medical conference", startDate: "2024-09-14", venue: "Grand Hyatt Washington", city: "Washington", state: "DC", expectedAttendance: 780, attendanceConfidence: "VERIFIED", verificationStatus: "VERIFIED", series: { key: "chd-conference", name: "CHD Conference", cadence: "ANNUAL", recurrenceConfidence: "HIGH" } },

  // ── Mid-Atlantic Tech Expo — big verified trade show, VERIFIED planner (best case) ────────────
  {
    externalId: "matexpo-2026",
    name: "Mid-Atlantic Tech Expo 2026",
    description: "Regional technology trade show with a large exhibit floor, sponsor activations and an opening-night reception.",
    category: "Trade show",
    startDate: "2026-11-12",
    endDate: "2026-11-13",
    venue: "Walter E. Washington Convention Center",
    address: "801 Mt Vernon Pl NW",
    city: "Washington",
    state: "DC",
    sourceUrl: "https://example-demo.org/matexpo",
    expectedAttendance: 2500,
    attendanceConfidence: "VERIFIED",
    verificationStatus: "VERIFIED",
    attributes: { exhibitors: "PRESENT", reception: "PRESENT", sponsor_activation: "PRESENT", networking: "PRESENT", vip: "PRESENT", outdoor: "ABSENT", virtual: "ABSENT" },
    organization: { name: "Mid-Atlantic Technology Council", website: "https://example-demo.org/matc", orgType: "ASSOCIATION", verificationStatus: "VERIFIED" },
    planners: [{ name: "Dana Whitfield", role: "Director of Events", email: "events@example-demo.org", agency: "Whitfield Event Partners", contactStatus: "VERIFIED", confidence: 0.9, evidence: "Named on the expo's official 'contact the events team' page (demo)." }],
  },

  // ── Bethesda Corporate Leadership Summit — INFERRED planner (name only, no contact) ───────────
  {
    externalId: "bethesda-summit-2027",
    name: "Bethesda Corporate Leadership Summit 2027",
    description: "Executive leadership summit with breakout sessions and a networking reception.",
    category: "Corporate event",
    startDate: "2027-03-04",
    venue: "Bethesda North Marriott",
    city: "Bethesda",
    state: "MD",
    expectedAttendance: 400,
    attendanceConfidence: "INFERRED",
    verificationStatus: "INFERRED",
    attributes: { reception: "PRESENT", networking: "PRESENT", exhibitors: "UNKNOWN", outdoor: "UNKNOWN" },
    organization: { name: "Beltway Executive Forum", orgType: "CORPORATE", verificationStatus: "INFERRED" },
    planners: [{ name: "Marcus Lee", role: "Program Chair (listed on prior year's agenda)", contactStatus: "INFERRED", confidence: 0.5, evidence: "Listed as program chair on the 2026 agenda; no direct contact published (demo)." }],
  },

  // ── National Harbor Wine & Food Gala — HIGH, outdoor + VIP + hospitality, VERIFIED planner ────
  {
    externalId: "nh-gala-2027",
    name: "National Harbor Wine & Food Gala 2027",
    description: "Black-tie waterfront gala with an outdoor reception, VIP lounge and hospitality suites.",
    category: "Gala",
    startDate: "2027-05-15",
    venue: "Gaylord National Resort",
    city: "National Harbor",
    state: "MD",
    expectedAttendance: 600,
    attendanceConfidence: "INFERRED",
    verificationStatus: "INFERRED",
    attributes: { gala: "PRESENT", reception: "PRESENT", vip: "PRESENT", outdoor: "PRESENT", hospitality: "PRESENT", virtual: "ABSENT" },
    organization: { name: "Potomac Culinary Foundation", orgType: "NONPROFIT", verificationStatus: "VERIFIED" },
    planners: [{ name: "Priya Nadella", role: "Development & Events Lead", email: "priya@example-demo.org", phone: "202-555-0142", contactStatus: "VERIFIED", confidence: 0.85, evidence: "Direct contact on the foundation's staff directory (demo)." }],
  },

  // ── NoVA Nonprofit Fundraiser Breakfast — IMMINENT, smaller, UNKNOWN planner ──────────────────
  {
    externalId: "nova-breakfast-2026",
    name: "NoVA Nonprofit Fundraiser Breakfast 2026",
    category: "Fundraiser",
    startDate: "2026-10-03",
    venue: "Ritz-Carlton Tysons Corner",
    city: "McLean",
    state: "VA",
    expectedAttendance: 120,
    attendanceConfidence: "INFERRED",
    verificationStatus: "INFERRED",
    attributes: { networking: "PRESENT", reception: "ABSENT", outdoor: "ABSENT" },
    organization: { name: "Northern Virginia Community Fund", orgType: "NONPROFIT", verificationStatus: "INFERRED" },
  },

  // ── Baltimore Medical Society Annual Meeting — recurring, announced 2027, INFERRED planner ────
  {
    externalId: "bms-2027",
    name: "Baltimore Medical Society Annual Meeting 2027",
    description: "Three-day medical association meeting with exhibit hall, awards gala and reception.",
    category: "Association meeting",
    startDate: "2027-04-22",
    endDate: "2027-04-24",
    venue: "Baltimore Convention Center",
    city: "Baltimore",
    state: "MD",
    expectedAttendance: 1800,
    attendanceConfidence: "VERIFIED",
    verificationStatus: "VERIFIED",
    attributes: { exhibitors: "PRESENT", reception: "PRESENT", gala: "PRESENT", networking: "PRESENT", virtual: "ABSENT" },
    organization: { name: "Baltimore Medical Society", website: "https://example-demo.org/bms", orgType: "ASSOCIATION", verificationStatus: "VERIFIED" },
    series: { key: "bms-annual", name: "Baltimore Medical Society Annual Meeting", cadence: "ANNUAL", recurrenceConfidence: "MEDIUM" },
    planners: [{ name: "Office of the Executive Director", role: "Meetings office", email: "meetings@example-demo.org", contactStatus: "INFERRED", confidence: 0.6, evidence: "General meetings inbox on the society site; no named planner (demo)." }],
  },
  { externalId: "bms-2026", name: "Baltimore Medical Society Annual Meeting 2026", category: "Association meeting", startDate: "2026-04-23", venue: "Baltimore Convention Center", city: "Baltimore", state: "MD", expectedAttendance: 1700, attendanceConfidence: "VERIFIED", verificationStatus: "VERIFIED", series: { key: "bms-annual", name: "Baltimore Medical Society Annual Meeting", cadence: "ANNUAL", recurrenceConfidence: "MEDIUM" } },

  // ── Howard County Chamber Awards Night — awards + gala, VERIFIED planner ───────────────────────
  {
    externalId: "hoco-awards-2027",
    name: "Howard County Chamber Awards Night 2027",
    category: "Awards event",
    startDate: "2027-01-30",
    venue: "Merriweather District",
    city: "Columbia",
    state: "MD",
    expectedAttendance: 300,
    attendanceConfidence: "INFERRED",
    verificationStatus: "INFERRED",
    attributes: { gala: "PRESENT", reception: "PRESENT", vip: "PRESENT", outdoor: "ABSENT" },
    organization: { name: "Howard County Chamber of Commerce", orgType: "ASSOCIATION", verificationStatus: "VERIFIED" },
    planners: [{ name: "Renee Ortiz", role: "Events Manager", email: "rortiz@example-demo.org", contactStatus: "VERIFIED", confidence: 0.8, evidence: "Chamber staff page (demo)." }],
  },

  // ── DC Green Building Symposium — recurring, NEXT ONLY PREDICTED/UNANNOUNCED, UNKNOWN planner ──
  { externalId: "dcgb-2026", name: "DC Green Building Symposium 2026", description: "Sustainable design symposium with an exhibit area and evening networking reception.", category: "Conference", startDate: "2026-08-20", venue: "Ronald Reagan Building", city: "Washington", state: "DC", expectedAttendance: 500, attendanceConfidence: "VERIFIED", verificationStatus: "VERIFIED", attributes: { reception: "PRESENT", exhibitors: "PRESENT", networking: "PRESENT" }, organization: { name: "Capital Sustainability Council", orgType: "NONPROFIT", verificationStatus: "INFERRED" }, series: { key: "dc-green-building", name: "DC Green Building Symposium", cadence: "ANNUAL", recurrenceConfidence: "HIGH" } },
  { externalId: "dcgb-2025", name: "DC Green Building Symposium 2025", category: "Conference", startDate: "2025-08-21", venue: "Ronald Reagan Building", city: "Washington", state: "DC", expectedAttendance: 480, attendanceConfidence: "VERIFIED", verificationStatus: "VERIFIED", series: { key: "dc-green-building", name: "DC Green Building Symposium", cadence: "ANNUAL", recurrenceConfidence: "HIGH" } },
  { externalId: "dcgb-2024", name: "DC Green Building Symposium 2024", category: "Conference", startDate: "2024-08-22", venue: "Ronald Reagan Building", city: "Washington", state: "DC", expectedAttendance: 450, attendanceConfidence: "VERIFIED", verificationStatus: "VERIFIED", series: { key: "dc-green-building", name: "DC Green Building Symposium", cadence: "ANNUAL", recurrenceConfidence: "HIGH" } },

  // ── Georgetown University Alumni Weekend — MANY UNKNOWNS (low commercial confidence) ──────────
  {
    externalId: "gu-alumni-2027",
    name: "Georgetown University Alumni Weekend 2027",
    category: "University event",
    startDate: "2027-06-04",
    venue: "Georgetown University",
    city: "Washington",
    state: "DC",
    verificationStatus: "NOT_YET_VERIFIED",
    attributes: { reception: "UNKNOWN", outdoor: "UNKNOWN", networking: "UNKNOWN", exhibitors: "UNKNOWN" },
    organization: { name: "Georgetown University", website: "https://example-demo.edu", orgType: "UNIVERSITY", verificationStatus: "VERIFIED" },
  },

  // ── NEGATIVE: fully virtual (should be UNQUALIFIED) ───────────────────────────────────────────
  {
    externalId: "devops-online-2027",
    name: "DevOps Online Conference 2027",
    category: "Conference",
    startDate: "2027-02-10",
    venue: "Online",
    city: "Online",
    expectedAttendance: 5000,
    attendanceConfidence: "VERIFIED",
    verificationStatus: "VERIFIED",
    attributes: { virtual: "PRESENT", networking: "PRESENT" },
  },

  // ── NEGATIVE: out of service area (should be UNQUALIFIED) ─────────────────────────────────────
  {
    externalId: "nyc-finance-2027",
    name: "Manhattan Finance Forum 2027",
    category: "Conference",
    startDate: "2027-03-18",
    venue: "Javits Center",
    city: "New York",
    state: "NY",
    expectedAttendance: 3000,
    attendanceConfidence: "VERIFIED",
    verificationStatus: "VERIFIED",
    attributes: { exhibitors: "PRESENT", reception: "PRESENT" },
  },
];

/** The MVP's one working source: a hand-curated DEMO dataset. It behaves exactly like a real source
 *  (goes through discover → normalize → dedupe → verify → store), so wiring a real fetcher later means
 *  implementing the same interface — nothing downstream changes. */
export const SEED_SOURCE: EventSource = {
  id: "seed-dmv-demo",
  name: "DMV Demo Dataset",
  kind: "DIRECTORY",
  region: "DMV",
  adapter: "seed",
  isSeed: true,
  discover: () => SEED_EVENTS,
};

// Real DMV sources the engine is DESIGNED to pull from — registered here as disabled/never-run stubs
// (adapter=null = fetcher not yet implemented). They make the registry on the dashboard concrete and
// document where real ingestion plugs in.
const SOURCE_STUBS = [
  { id: "src-waltere-convention", name: "Walter E. Washington Convention Center — event calendar", kind: "CONVENTION_CENTER", url: "https://example.org", region: "DC" },
  { id: "src-gaylord-national", name: "Gaylord National Resort — group calendar", kind: "HOTEL", url: "https://example.org", region: "PRINCE_GEORGES_MD" },
  { id: "src-baltimore-convention", name: "Baltimore Convention Center — event calendar", kind: "CONVENTION_CENTER", url: "https://example.org", region: "BALTIMORE" },
  { id: "src-umd", name: "University of Maryland — events", kind: "UNIVERSITY", url: "https://example.org", region: "PRINCE_GEORGES_MD" },
  { id: "src-assoc-directory", name: "DMV association directory", kind: "DIRECTORY", url: "https://example.org", region: "DMV" },
  { id: "src-search", name: "Search-discovered event pages", kind: "SEARCH", url: null, region: "DMV" },
] as const;

/** Idempotently register the source registry (the seed source + the real-source stubs). */
export function ensureSources(now: Date = new Date()): void {
  upsertSource({ id: SEED_SOURCE.id, name: SEED_SOURCE.name, kind: SEED_SOURCE.kind, url: null, region: "DMV", enabled: true, adapter: "seed", isSeed: true }, now);
  for (const s of SOURCE_STUBS) {
    upsertSource({ id: s.id, name: s.name, kind: s.kind, url: s.url ?? null, region: s.region, enabled: false, adapter: null, isSeed: false }, now);
  }
}

/** Seed the demo dataset if Event Radar is empty. Idempotent (upserts by dedupe_key), so a second call
 *  is a no-op. Returns whether it actually seeded. */
export async function seedRadarIfEmpty(now: Date = new Date()): Promise<boolean> {
  ensureSources(now);
  if (getEventCount() > 0) return false;
  await runSource(SEED_SOURCE, now);
  return true;
}

/** Force a (re-)seed regardless of current contents — for an explicit "load demo data" action. */
export async function reseedRadar(now: Date = new Date()): Promise<void> {
  ensureSources(now);
  await runSource(SEED_SOURCE, now);
}
