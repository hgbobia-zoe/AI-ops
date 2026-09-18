// Opportunity Radar — deterministic research suggestions (§7 "recommended action"). Rules, not AI:
// turn what we DON'T know about an opportunity into concrete next steps a rep can take to qualify it.

import type { OpportunityView } from "./service";
import type { OpportunityKind } from "./types";

/** A plain "likely needs" phrase per kind, used when no Zoe categories were detected in the text. */
export const CATEGORY_ANALOG: Record<OpportunityKind, string> = {
  EVENT: "tents, tables, chairs and event furniture",
  PROCUREMENT: "event infrastructure (tents, tables, chairs, staging)",
  FACILITY_SIGNAL: "grand-opening tenting, furniture and lighting",
  WEB_SIGNAL: "event rentals (to be confirmed)",
};

/** Concrete research actions derived from the view's unknowns + missing pieces. Always 2–4 items. */
export function describeUnknowns(v: OpportunityView): string[] {
  const actions: string[] = [];
  if (!v.primaryTarget) actions.push(v.opp.kind === "PROCUREMENT" ? "Identify the prime / event-management company likely to win this" : "Identify the event planner or organizer to contact");
  for (const u of v.score.unknowns) {
    if (u.key === "attendance" || u.key === "size") actions.push("Confirm the expected attendance / scope");
    else if (u.key === "categories") actions.push("Confirm which rentals are needed (tent, tables, chairs, staging, flooring)");
    else if (u.key === "region") actions.push("Confirm the exact venue / location");
  }
  if (v.opp.kind === "PROCUREMENT" && !v.opp.deadline) actions.push("Find the solicitation response deadline");
  if (v.opp.verificationStatus === "NOT_YET_VERIFIED") actions.push("Verify the opportunity against its source");
  // De-dupe and cap.
  const seen = new Set<string>();
  const unique = actions.filter((a) => (seen.has(a) ? false : (seen.add(a), true)));
  if (unique.length === 0) unique.push("Reach out to the identified target to confirm needs and timing");
  return unique.slice(0, 4);
}
