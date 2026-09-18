// Opportunity Radar — campaigns (§11). A campaign is a named grouping of opportunities with target
// criteria. Membership is deterministic: an opportunity matches a campaign's criteria (kinds,
// jurisdictions, min score, categories) OR is manually assigned. Metrics are DERIVED (opportunities,
// companies, contacts, outreach sent, won) so we can trace signal → outreach → revenue by campaign.

import { todayInOpsTz } from "@/lib/dates";
import { opportunityBoard, type OpportunityView } from "./service";
import { getCampaigns, getCampaign, setCampaign, getOpportunities, type StoredCampaign } from "./store";
import { enrolledOpportunityIds, contactedOpportunityIds } from "@/lib/prospecting/store";
import type { Jurisdiction, OpportunityKind, ZoeCategory } from "./types";

export interface CampaignCriteria {
  kinds?: OpportunityKind[];
  jurisdictions?: Jurisdiction[];
  minScore?: number;
  categories?: ZoeCategory[];
}

/** Whether an opportunity view matches a campaign's criteria (deterministic). */
export function matchesCriteria(v: OpportunityView, c: CampaignCriteria): boolean {
  if (c.kinds?.length && !c.kinds.includes(v.opp.kind)) return false;
  if (c.jurisdictions?.length && !c.jurisdictions.includes(v.opp.jurisdiction)) return false;
  if (c.minScore != null && v.score.opportunityScore < c.minScore) return false;
  if (c.categories?.length && !c.categories.some((cat) => v.opp.zoeCategories.includes(cat))) return false;
  return true;
}

export interface CampaignMetrics {
  campaign: StoredCampaign;
  opportunities: number;
  companies: number;
  contacts: number;
  qualified: number;
  outreachDrafted: number;
  outreachSent: number;
  contacted: number;
  won: number;
  indicativeValueHigh: number;
  conversionRate: number | null; // contacted / opportunities
}

function metricsFor(campaign: StoredCampaign, members: OpportunityView[]): CampaignMetrics {
  const enrolled = enrolledOpportunityIds();
  const contactedSet = contactedOpportunityIds();
  const companies = new Set<string>();
  let contacts = 0;
  let outreachDrafted = 0;
  let outreachSent = 0;
  let contacted = 0;
  for (const v of members) {
    for (const e of v.entities) { companies.add(e.entity.id); if (e.entity.kind === "CONTACT" || e.entity.email) contacts++; }
    if (enrolled.has(v.opp.id)) outreachDrafted++;
    if (contactedSet.has(v.opp.id)) outreachSent++;
    if (contactedSet.has(v.opp.id) || ["CONTACTED", "ENGAGED", "OPPORTUNITY", "QUOTED", "WON"].includes(v.stage)) contacted++;
  }
  return {
    campaign,
    opportunities: members.length,
    companies: companies.size,
    contacts,
    qualified: members.filter((v) => v.score.tier !== "UNQUALIFIED").length,
    outreachDrafted,
    outreachSent,
    contacted,
    won: members.filter((v) => v.stage === "WON").length,
    indicativeValueHigh: members.reduce((s, v) => s + (v.value?.high ?? 0), 0),
    conversionRate: members.length ? contacted / members.length : null,
  };
}

/** All campaigns with derived metrics. */
export function listCampaignMetrics(today: string = todayInOpsTz()): CampaignMetrics[] {
  const board = opportunityBoard(today);
  const byId = new Map<string, OpportunityView[]>();
  for (const v of board.all) if (v.opp.campaignId) (byId.get(v.opp.campaignId) ?? byId.set(v.opp.campaignId, []).get(v.opp.campaignId)!).push(v);
  return getCampaigns().map((c) => metricsFor(c, byId.get(c.id) ?? []));
}

export interface CampaignDetail extends CampaignMetrics { members: OpportunityView[] }

export function campaignDetail(id: string, today: string = todayInOpsTz()): CampaignDetail | null {
  const campaign = getCampaign(id);
  if (!campaign) return null;
  const board = opportunityBoard(today);
  const members = board.all.filter((v) => v.opp.campaignId === id);
  return { ...metricsFor(campaign, members), members };
}

/** Auto-assign every opportunity matching the campaign's criteria. Returns count assigned. */
export function autoMatchCampaign(id: string, today: string = todayInOpsTz()): number {
  const campaign = getCampaign(id);
  if (!campaign || !campaign.criteria) return 0;
  const criteria = campaign.criteria as CampaignCriteria;
  const board = opportunityBoard(today);
  let n = 0;
  for (const v of board.all) {
    if (v.opp.campaignId) continue; // don't steal from another campaign
    if (matchesCriteria(v, criteria)) { setCampaign(v.opp.id, id); n++; }
  }
  return n;
}

export { getOpportunities };
