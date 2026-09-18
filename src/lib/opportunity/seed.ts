// Opportunity Radar — source registry + SEED/DEMO data. Every seeded row is is_seed=1 and badged SEED,
// run through the REAL pipeline (normalize → classify → dedupe → change-detect → store) so the workflow
// is evaluable with no API keys or browser agent. Registers the real connectors too: SAM.gov (dormant
// until SAM_API_KEY) and the Montgomery County browser workflow (fed via /api/radar/ingest).

import { getDb } from "@/lib/db";
import { runOpportunitySource, type OpportunitySource, type RawOpportunity } from "./ingest";
import { getOpportunityCount } from "./store";
import { syncEventOpportunities } from "./eventBridge";
import { samGovSource, samGovConfigured } from "./sources/samgov";
import { MONTGOMERY_COUNTY_WORKFLOW } from "./sources/browser";

// ── Source registry ───────────────────────────────────────────────────────────────────────────────
interface SourceRow {
  id: string; name: string; kind: string; url: string | null; region: string; enabled: number;
  acquisition_method: string; auth_status: string; frequency: string; adapter: string | null; is_seed: number;
}

function registerSources(now: Date): void {
  const db = getDb();
  const ts = now.toISOString();
  const rows: SourceRow[] = [
    { id: "seed-opportunity-demo", name: "Opportunity demo dataset", kind: "DIRECTORY", url: null, region: "DMV", enabled: 1, acquisition_method: "MANUAL", auth_status: "NONE", frequency: "manual", adapter: "seed", is_seed: 1 },
    { id: "samgov-federal", name: "SAM.gov — federal solicitations", kind: "FEDERAL_API", url: "https://sam.gov", region: "FEDERAL", enabled: 1, acquisition_method: "API", auth_status: samGovConfigured() ? "REQUIRED_OK" : "REQUIRED_MISSING", frequency: "daily", adapter: "samgov", is_seed: 0 },
    { id: MONTGOMERY_COUNTY_WORKFLOW.sourceId, name: MONTGOMERY_COUNTY_WORKFLOW.name, kind: "COUNTY_PORTAL", url: MONTGOMERY_COUNTY_WORKFLOW.portalUrl, region: "MONTGOMERY_MD", enabled: 1, acquisition_method: "BROWSER", auth_status: "NONE", frequency: "weekly", adapter: `browser:${MONTGOMERY_COUNTY_WORKFLOW.sourceId}`, is_seed: 0 },
    { id: "emma-md", name: "Maryland eMMA (state procurement)", kind: "STATE_PORTAL", url: "https://emma.maryland.gov", region: "STATE_MD", enabled: 0, acquisition_method: "BROWSER", auth_status: "NONE", frequency: "weekly", adapter: null, is_seed: 0 },
    { id: "dc-ocp", name: "DC Office of Contracting & Procurement", kind: "CITY_PORTAL", url: "https://ocp.dc.gov", region: "DC", enabled: 0, acquisition_method: "BROWSER", auth_status: "NONE", frequency: "weekly", adapter: null, is_seed: 0 },
    { id: "rockville-procurement", name: "City of Rockville procurement", kind: "CITY_PORTAL", url: "https://www.rockvillemd.gov", region: "MONTGOMERY_MD", enabled: 0, acquisition_method: "BROWSER", auth_status: "NONE", frequency: "weekly", adapter: null, is_seed: 0 },
    { id: "gaithersburg-procurement", name: "City of Gaithersburg procurement", kind: "CITY_PORTAL", url: "https://www.gaithersburgmd.gov", region: "MONTGOMERY_MD", enabled: 0, acquisition_method: "BROWSER", auth_status: "NONE", frequency: "weekly", adapter: null, is_seed: 0 },
  ];
  const stmt = db.prepare(
    `INSERT INTO radar_sources (id, name, kind, url, region, enabled, adapter, acquisition_method, auth_status, frequency, last_status, is_seed, created_at)
     VALUES (@id,@name,@kind,@url,@region,@enabled,@adapter,@acquisition_method,@auth_status,@frequency,'NEVER_RUN',@is_seed,@ts)
     ON CONFLICT(id) DO UPDATE SET name=@name, kind=@kind, url=@url, region=@region, enabled=@enabled, adapter=@adapter,
       acquisition_method=@acquisition_method, auth_status=@auth_status, frequency=@frequency`,
  );
  for (const r of rows) stmt.run({ ...r, ts });
}

// ── Seed dataset (procurement + facility signals) ────────────────────────────────────────────────
const SEED_OPPS: RawOpportunity[] = [
  {
    externalId: "moco-event-mgmt-2027",
    kind: "PROCUREMENT",
    name: "Event Management Services for County Signature Events 2027",
    description: "Montgomery County seeks event management for large public events, including tenting, tables, chairs, staging and flooring for outdoor festivals.",
    sourceUrl: "https://example-demo.gov/moco/rfp-2027-event",
    agency: "Montgomery County Government",
    city: "Rockville", state: "MD",
    deadline: "2026-11-16", status: "open", verificationStatus: "INFERRED",
    entities: [
      { name: "Montgomery County Office of Procurement", kind: "AGENCY", role: "DIRECT_BUYER", evidence: "Named issuing office (demo)." },
      { name: "Beltway Event Management LLC", kind: "PRODUCTION", role: "EVENT_MGMT", evidence: "Incumbent event manager listed on the prior contract (demo).", isPrimaryTarget: true },
    ],
    procurement: { solicitationNumber: "MC-2027-EVT-014", noticeType: "RFP", responseDeadline: "2026-11-16", naics: "561920" },
  },
  {
    externalId: "rockville-july4-2027",
    kind: "PROCUREMENT",
    name: "Independence Day Festival — Tenting, Staging & Seating",
    description: "City of Rockville invites bids for tents, a main stage, chairs and portable restrooms for the July 4th festival.",
    sourceUrl: "https://example-demo.gov/rockville/ifb-july4",
    agency: "City of Rockville", city: "Rockville", state: "MD",
    deadline: "2026-10-12", status: "open", verificationStatus: "INFERRED",
    entities: [{ name: "City of Rockville Purchasing", kind: "AGENCY", role: "DIRECT_BUYER" }],
    procurement: { solicitationNumber: "ROCK-IFB-2664", noticeType: "IFB", responseDeadline: "2026-10-12" },
  },
  {
    externalId: "nih-wellness-expo-2027",
    kind: "PROCUREMENT",
    name: "Sources Sought — Campus Wellness Expo Support Services",
    description: "Federal sources-sought for a campus wellness expo: tents, tables, chairs and exhibitor infrastructure in Bethesda.",
    sourceUrl: "https://example-demo.gov/sam/nih-expo",
    agency: "National Institutes of Health", city: "Bethesda", state: "MD",
    deadline: "2027-01-20", status: "open", verificationStatus: "INFERRED",
    entities: [{ name: "National Institutes of Health", kind: "AGENCY", role: "DIRECT_BUYER" }],
    procurement: { solicitationNumber: "NIH-SS-88213", noticeType: "SOURCES_SOUGHT", responseDeadline: "2027-01-20", naics: "532289" },
  },
  {
    externalId: "natl-harbor-grand-opening-2027",
    kind: "FACILITY_SIGNAL",
    name: "Grand Opening — New Waterfront Conference Hotel, National Harbor",
    description: "Construction completion celebration and grand opening planned; likely tenting, event furniture and lighting for an outdoor reception.",
    sourceUrl: "https://example-demo.com/natlharbor-opening",
    agency: "Harbor Development Partners", city: "National Harbor", state: "MD",
    estimatedDate: "2027-06-05", status: "planning", verificationStatus: "NOT_YET_VERIFIED",
    entities: [{ name: "Harbor Development Partners", kind: "FACILITIES", role: "FACILITIES_CONTRACTOR", evidence: "Named developer in the demo listing." }],
  },
  {
    externalId: "pg-cultural-festival-award-2026",
    kind: "PROCUREMENT",
    name: "Cultural Festival Event Services — Contract Award",
    description: "Prince George's County awarded event services (tents, tables, chairs, staging) for its annual cultural festival.",
    sourceUrl: "https://example-demo.gov/pg/award-cultural",
    agency: "Prince George's County", city: "Largo", state: "MD",
    deadline: null, status: "awarded", verificationStatus: "INFERRED",
    entities: [
      { name: "Prince George's County Government", kind: "AGENCY", role: "DIRECT_BUYER" },
      { name: "XYZ Events Group", kind: "PRODUCTION", role: "EVENT_MGMT", evidence: "Named awardee (demo).", isPrimaryTarget: true },
    ],
    procurement: { solicitationNumber: "PG-2026-CF-07", noticeType: "AWARD", awardee: "XYZ Events Group", awardAmount: 240000, awardDate: "2026-09-01" },
  },
  {
    externalId: "nyc-courthouse-2027",
    kind: "PROCUREMENT",
    name: "Federal Courthouse Ceremony Event Services (New York, NY)",
    description: "Event services for a federal ceremony in Manhattan — outside the DMV service area (negative-control demo).",
    sourceUrl: "https://example-demo.gov/sam/nyc-courthouse",
    agency: "General Services Administration", city: "New York", state: "NY",
    deadline: "2027-02-15", status: "open", verificationStatus: "VERIFIED",
    entities: [{ name: "General Services Administration", kind: "AGENCY", role: "DIRECT_BUYER" }],
    procurement: { solicitationNumber: "GSA-NY-9910", noticeType: "RFP", responseDeadline: "2027-02-15" },
  },
];

const SEED_SOURCE: OpportunitySource = {
  id: "seed-opportunity-demo",
  name: "Opportunity demo dataset",
  kind: "DIRECTORY",
  acquisitionMethod: "MANUAL",
  adapter: "seed",
  isSeed: true,
  acquire: () => SEED_OPPS,
};

/** Idempotently register sources, bridge events, and seed the demo dataset when empty. */
export async function seedOpportunitiesIfEmpty(now: Date = new Date()): Promise<boolean> {
  registerSources(now);
  syncEventOpportunities(now);
  if (getOpportunityCount() === 0 || onlyEventOpportunities()) {
    await runOpportunitySource(SEED_SOURCE, now);
    return true;
  }
  return false;
}

function onlyEventOpportunities(): boolean {
  const n = (getDb().prepare("SELECT COUNT(*) AS n FROM opportunities WHERE kind != 'EVENT'").get() as { n: number }).n;
  return n === 0;
}

/** Refresh on load: bridge new events + pull any live connectors that are configured (SAM.gov). */
export async function refreshOpportunities(now: Date = new Date()): Promise<void> {
  registerSources(now);
  syncEventOpportunities(now);
  if (samGovConfigured()) await runOpportunitySource(samGovSource(), now);
}

/** Force a (re-)seed of the demo dataset. */
export async function reseedOpportunities(now: Date = new Date()): Promise<void> {
  registerSources(now);
  syncEventOpportunities(now);
  await runOpportunitySource(SEED_SOURCE, now);
}
