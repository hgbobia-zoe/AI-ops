// Opportunity Radar — event bridge. Projects each Event Radar event (radar_events) into the unified
// `opportunities` spine so events and procurement feed ONE intelligence layer (§9). Idempotent: keyed
// by `event:<eventId>`, a re-run updates in place. Known planners become relationship-graph entities.

import { getEvents, getOrganization, getPlannersForEvent, type StoredEvent } from "@/lib/radar/store";
import { normalizeRegion } from "@/lib/radar/geo";
import { normalizeJurisdiction } from "./jurisdiction";
import { classifyZoeCategories } from "./classify";
import { upsertOpportunity, upsertEntity, linkEntity, setPrimaryTarget, getOpportunityByDedupe } from "./store";

function bridgeOne(event: StoredEvent, now: Date): void {
  const dedupeKey = `event:${event.id}`;
  const region = normalizeRegion({ city: event.city, state: event.state, address: event.address });
  const org = getOrganization(event.organizationId);
  const jurisdiction = normalizeJurisdiction({ agency: org?.name ?? null, text: `${event.name} ${event.description ?? ""}`, region });

  const opp = upsertOpportunity(
    {
      dedupeKey,
      kind: "EVENT",
      name: event.name,
      description: event.description,
      sourceId: event.sourceId,
      sourceName: event.sourceName,
      sourceUrl: event.sourceUrl,
      jurisdiction,
      region,
      city: event.city,
      state: event.state,
      organization: org?.name ?? null,
      estimatedDate: event.startDate,
      deadline: null,
      status: event.eventStatus,
      zoeCategories: classifyZoeCategories(`${event.name} ${event.description ?? ""}`),
      verificationStatus: event.verificationStatus,
      eventId: event.id,
      isSeed: event.isSeed,
    },
    now,
  );

  // Known planners → relationship-graph contacts (the recommended target for an event).
  const planners = getPlannersForEvent(event.id, event.organizationId).filter((p) => p.contactStatus !== "UNKNOWN");
  let primaryEntityId: string | null = null;
  for (const p of planners) {
    const ent = upsertEntity(
      { name: p.name, kind: "EVENT_PLANNER", website: null, email: p.email, phone: p.phone, jurisdiction: null, verificationStatus: p.contactStatus, matchedCustomerKey: null, notes: p.evidence, isSeed: event.isSeed },
      now,
    );
    linkEntity(opp.id, ent.id, "EVENT_PLANNER", { confidence: p.confidence ?? undefined, evidence: p.evidence ?? undefined }, now);
    if (!primaryEntityId) primaryEntityId = ent.id;
  }
  if (primaryEntityId) setPrimaryTarget(opp.id, primaryEntityId);
}

/** Ensure every radar event has a corresponding opportunity. Idempotent. Returns count bridged. */
export function syncEventOpportunities(now: Date = new Date()): number {
  const events = getEvents();
  let n = 0;
  for (const e of events) {
    // Skip if already present and unchanged-enough — upsert is cheap, so just always upsert.
    bridgeOne(e, now);
    n++;
  }
  return n;
}

/** Whether the bridge has run at least once (any EVENT-kind opportunity exists). */
export function hasBridgedEvents(): boolean {
  return getEvents().some((e) => getOpportunityByDedupe(`event:${e.id}`) != null);
}
