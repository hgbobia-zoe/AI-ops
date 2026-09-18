// Opportunity Radar — browser-agent connectors (§15). Portals with no API (county/city procurement)
// are pulled by a LOCAL browser agent the user already has: it runs a DEFINED per-source workflow
// (search terms + geographic filters — never a blind crawl), extracts rows, and POSTs normalized
// records to /api/radar/ingest (token-gated, CORS-locked — the same pattern as the Goodshuffle
// Auto-Pull). This module holds the workflow DEFINITIONS (data, for the agent to follow) and builds an
// in-memory OpportunitySource from posted records so they flow through the identical pipeline.

import type { OpportunitySource, RawOpportunity } from "../ingest";
import type { Jurisdiction } from "../types";

export interface BrowserWorkflow {
  sourceId: string;
  name: string;
  jurisdiction: Jurisdiction;
  portalUrl: string;
  /** Search terms the agent enters (kept tight so we pull event-relevant notices, not the whole site). */
  searchTerms: string[];
  /** Geographic filters the agent applies in the portal, when the portal supports them. */
  geoFilters: string[];
  parserVersion: string;
  notes: string;
}

// The one worked example for Phase 1. Others (eMMA, Rockville, Gaithersburg, DC) are Phase 2 and can be
// added here without touching the pipeline.
export const MONTGOMERY_COUNTY_WORKFLOW: BrowserWorkflow = {
  sourceId: "moco-procurement",
  name: "Montgomery County procurement",
  jurisdiction: "MONTGOMERY_CO",
  portalUrl: "https://www.montgomerycountymd.gov/PRO/",
  searchTerms: ["event", "rental", "tent", "conference", "furniture", "chairs", "tables", "event services", "temporary structures"],
  geoFilters: ["Montgomery County", "Rockville", "Bethesda", "Gaithersburg"],
  parserVersion: "1",
  notes: "Solicitations + contract awards for event services. Agent runs each search term, extracts rows (title, solicitation #, due date, status, link), POSTs to /api/radar/ingest with sourceId=moco-procurement.",
};

const EVENT_TERMS = ["event", "rental", "tent", "conference", "furniture", "chairs", "tables", "event services", "temporary structures", "staging"];

export const MARYLAND_EMMA_WORKFLOW: BrowserWorkflow = {
  sourceId: "emma-md",
  name: "Maryland eMMA (state procurement)",
  jurisdiction: "STATE_MD",
  portalUrl: "https://emma.maryland.gov",
  searchTerms: EVENT_TERMS,
  geoFilters: ["Maryland"],
  parserVersion: "1",
  notes: "Statewide solicitations. Agent runs each search term under Browse Public Solicitations, extracts rows (title, solicitation #, due date, category, link), POSTs to /api/radar/ingest with sourceId=emma-md.",
};

export const ROCKVILLE_WORKFLOW: BrowserWorkflow = {
  sourceId: "rockville-procurement",
  name: "City of Rockville procurement",
  jurisdiction: "ROCKVILLE",
  portalUrl: "https://www.rockvillemd.gov/bids.aspx",
  searchTerms: EVENT_TERMS,
  geoFilters: ["Rockville"],
  parserVersion: "1",
  notes: "City bid board. Agent opens the open-bids list, extracts event-relevant rows, POSTs to /api/radar/ingest with sourceId=rockville-procurement.",
};

export const GAITHERSBURG_WORKFLOW: BrowserWorkflow = {
  sourceId: "gaithersburg-procurement",
  name: "City of Gaithersburg procurement",
  jurisdiction: "GAITHERSBURG",
  portalUrl: "https://www.gaithersburgmd.gov/government/departments/finance-administration/purchasing",
  searchTerms: EVENT_TERMS,
  geoFilters: ["Gaithersburg"],
  parserVersion: "1",
  notes: "City purchasing page. Agent extracts current solicitations for event-relevant terms, POSTs to /api/radar/ingest with sourceId=gaithersburg-procurement.",
};

export const DC_OCP_WORKFLOW: BrowserWorkflow = {
  sourceId: "dc-ocp",
  name: "DC Office of Contracting & Procurement",
  jurisdiction: "DC",
  portalUrl: "https://ocp.dc.gov/page/solicitations",
  searchTerms: EVENT_TERMS,
  geoFilters: ["District of Columbia", "Washington DC"],
  parserVersion: "1",
  notes: "DC OCP solicitations. Agent runs each search term, extracts rows, POSTs to /api/radar/ingest with sourceId=dc-ocp.",
};

export const BROWSER_WORKFLOWS: BrowserWorkflow[] = [
  MONTGOMERY_COUNTY_WORKFLOW,
  MARYLAND_EMMA_WORKFLOW,
  ROCKVILLE_WORKFLOW,
  GAITHERSBURG_WORKFLOW,
  DC_OCP_WORKFLOW,
];

export function getWorkflow(sourceId: string): BrowserWorkflow | null {
  return BROWSER_WORKFLOWS.find((w) => w.sourceId === sourceId) ?? null;
}

/** Coerce a loosely-shaped posted record (from the browser agent) into a RawOpportunity. Defensive: the
 *  agent output is untrusted, so we only trust known fields and never execute anything from it. */
export function coerceRecord(raw: unknown): RawOpportunity | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name : typeof r.title === "string" ? (r.title as string) : null;
  if (!name) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  return {
    externalId: str(r.externalId) ?? str(r.solicitationNumber),
    kind: "PROCUREMENT",
    name,
    description: str(r.description),
    sourceUrl: str(r.sourceUrl) ?? str(r.url),
    agency: str(r.agency),
    city: str(r.city),
    state: str(r.state),
    deadline: str(r.deadline) ?? str(r.dueDate) ?? null,
    status: str(r.status),
    verificationStatus: "INFERRED",
    valueHigh: num(r.value),
    procurement: {
      solicitationNumber: str(r.solicitationNumber),
      noticeType: str(r.noticeType),
      responseDeadline: str(r.deadline) ?? str(r.dueDate),
      awardee: str(r.awardee),
    },
  };
}

/** Build an in-memory source from records the browser agent posted for a given workflow. */
export function buildBrowserSource(workflow: BrowserWorkflow, records: RawOpportunity[]): OpportunitySource {
  return {
    id: workflow.sourceId,
    name: workflow.name,
    kind: "COUNTY_PORTAL",
    acquisitionMethod: "BROWSER",
    adapter: `browser:${workflow.sourceId}`,
    acquire: () => records,
  };
}
