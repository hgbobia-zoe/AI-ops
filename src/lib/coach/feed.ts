// Build a conversation feed for a customer: their calls (from call_events, each with its AI summary +
// next step) merged with their texts (from comms_events), chronological (oldest → newest). Server-only.

import { getCallEventById, getCoachingAnalysis, type CoachableCall, type CommsEventView } from "@/lib/db/repo";
import type { CallItem, TextItem, TimelineItem } from "./feedTypes";

/** Map coachable calls to feed items, pulling each call's Quo summary / recap. */
export function callFeedItems(calls: CoachableCall[]): CallItem[] {
  return calls.map((c) => {
    const rc = getCoachingAnalysis(c.id);
    const ev = getCallEventById(c.id);
    const summary = rc?.keyPoints?.length ? rc.keyPoints : ev?.summary ? [ev.summary] : [];
    return { kind: "call", id: c.id, direction: c.direction, at: c.occurredAt ?? c.ts, durationSec: c.durationSec, sentiment: c.sentiment, summary, nextStep: rc?.nextStep ?? "", analyzed: !!rc };
  });
}

/** Merge calls + text comms into one chronological feed (calls carry their summary inline). */
export function buildConversationFeed(calls: CoachableCall[], comms: CommsEventView[]): TimelineItem[] {
  const callItems = callFeedItems(calls);
  const textItems: TextItem[] = comms
    .filter((c) => c.channel !== "call")
    .map((c) => ({ kind: "text", id: c.id, direction: c.direction, body: c.body ?? "", actor: c.actor, at: c.occurredAt ?? c.ts }));
  return [...callItems, ...textItems].sort((a, b) => (Date.parse(a.at ?? "") || 0) - (Date.parse(b.at ?? "") || 0));
}
