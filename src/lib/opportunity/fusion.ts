// Opportunity Radar — signal fusion (§9). Deterministic detection of opportunities that are likely the
// SAME real-world opportunity seen through different signals (an event + a procurement + a web signal).
// No AI, no fabrication: we surface RELATED opportunities with the concrete reason they matched and a
// confidence, so a human (or a later phase) can merge them. "RULES CALCULATE."

import { getOpportunities, getEntitiesForOpportunity, type StoredOpportunity } from "./store";

const STOP = new Set(["the", "a", "an", "of", "for", "and", "to", "in", "on", "services", "service", "event", "events", "county", "city", "government", "annual", "2024", "2025", "2026", "2027", "2028"]);

function tokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/** Jaccard token overlap of two names, 0..1. */
export function nameSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

function daysApart(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  return Math.abs(Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000));
}

export interface RelatedOpportunity {
  opportunity: StoredOpportunity;
  reason: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

/** Find opportunities related to `id` — same jurisdiction plus a shared entity, a similar name, or the
 *  same organizer within a tight date window. Ranked strongest first. */
export function findRelated(id: string): RelatedOpportunity[] {
  const all = getOpportunities();
  const self = all.find((o) => o.id === id);
  if (!self) return [];

  const myEntities = new Set(getEntitiesForOpportunity(id).map((e) => e.entity.id));
  const out: RelatedOpportunity[] = [];

  for (const o of all) {
    if (o.id === id) continue;
    if (o.jurisdiction !== self.jurisdiction || self.jurisdiction === "UNKNOWN") continue;

    const shared = getEntitiesForOpportunity(o.id).filter((e) => myEntities.has(e.entity.id)).map((e) => e.entity.name);
    const nameSim = nameSimilarity(self.name, o.name);
    const dateGap = daysApart(self.estimatedDate ?? self.deadline, o.estimatedDate ?? o.deadline);
    const sameOrg = !!self.organization && !!o.organization && self.organization.toLowerCase() === o.organization.toLowerCase();

    if (shared.length > 0) {
      out.push({ opportunity: o, reason: `Shares ${shared.length === 1 ? "a contact" : "contacts"}: ${shared.join(", ")}`, confidence: "HIGH" });
    } else if (nameSim >= 0.5) {
      out.push({ opportunity: o, reason: `Very similar name (${Math.round(nameSim * 100)}% overlap)`, confidence: "HIGH" });
    } else if (sameOrg && dateGap != null && dateGap <= 45) {
      out.push({ opportunity: o, reason: `Same organizer, dates within ${dateGap}d`, confidence: "MEDIUM" });
    } else if (nameSim >= 0.3 || sameOrg) {
      out.push({ opportunity: o, reason: sameOrg ? "Same organizer" : `Similar name (${Math.round(nameSim * 100)}%)`, confidence: "LOW" });
    }
  }

  const rank = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  return out.sort((a, b) => rank[b.confidence] - rank[a.confidence]).slice(0, 8);
}
