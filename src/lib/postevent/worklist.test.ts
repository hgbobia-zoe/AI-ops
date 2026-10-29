// Service worklist derivation — pure, deterministic grouping of active board cards into the overview's
// service-first "what to do next". Asserts the service-first ordering, the issue-first override, the
// exclusion of closed / no-op cards, overdue counting, and the supportive (never "lost") framing.

import { describe, it, expect } from "vitest";
import { buildServiceWorklist } from "./worklist";
import type { PostEventCard, PostEventState, NextAction, Disposition } from "./types";

function card(over: Partial<PostEventCard> & { bookingId: string }): PostEventCard {
  return {
    bookingId: over.bookingId,
    state: (over.state ?? "needs_follow_up") as PostEventState,
    disposition: (over.disposition ?? null) as Disposition | null,
    nextAction: (over.nextAction ?? "call") as NextAction,
    assignedEmployee: over.assignedEmployee ?? null,
    customer: over.customer ?? "Test Customer",
    eventName: over.eventName ?? "Test Event",
    eventDate: over.eventDate ?? null,
    venue: over.venue ?? null,
    pickupAt: over.pickupAt ?? null,
    lastContactAt: over.lastContactAt ?? null,
    lastContactOutcome: over.lastContactOutcome ?? null,
    contactCount: over.contactCount ?? 0,
    respondedCount: over.respondedCount ?? 0,
    openIssues: over.openIssues ?? 0,
    daysInStage: over.daysInStage ?? 0,
    stateReason: over.stateReason ?? null,
    dueAt: over.dueAt ?? null,
    dueToday: over.dueToday ?? false,
    overdue: over.overdue ?? false,
    stale: over.stale ?? false,
  };
}

describe("buildServiceWorklist", () => {
  it("groups each active card into exactly one bucket by its next action, service-first ordered", () => {
    const cards: PostEventCard[] = [
      card({ bookingId: "A", state: "experience_confirmed", nextAction: "send_review_request" }), // invite
      card({ bookingId: "B", state: "customer_responded", nextAction: "review_feedback" }), // confirm
      card({ bookingId: "C", state: "needs_follow_up", nextAction: "call" }), // reach_out
      card({ bookingId: "D", state: "review_requested", nextAction: "await_response" }), // awaiting
    ];
    const { groups, activeTotal } = buildServiceWorklist(cards);
    expect(activeTotal).toBe(4);
    // Service-first: confirm before reach_out before awaiting before invite.
    expect(groups.map((g) => g.key)).toEqual(["confirm", "reach_out", "awaiting", "invite"]);
    for (const g of groups) expect(g.count).toBe(1);
  });

  it("routes any card with an open issue to service recovery first, whatever the generic next action", () => {
    const cards: PostEventCard[] = [
      card({ bookingId: "A", state: "experience_confirmed", nextAction: "follow_resolution", openIssues: 2 }),
      card({ bookingId: "B", state: "customer_responded", nextAction: "review_feedback", openIssues: 1 }), // issue overrides confirm
    ];
    const { groups } = buildServiceWorklist(cards);
    expect(groups[0].key).toBe("recover");
    expect(groups[0].count).toBe(2); // both, including the one whose stage action was "confirm"
    expect(groups.find((g) => g.key === "confirm")).toBeUndefined();
  });

  it("excludes closed cards and no-op (none) next actions", () => {
    const cards: PostEventCard[] = [
      card({ bookingId: "A", state: "closed", nextAction: "none" }),
      card({ bookingId: "B", state: "review_completed", nextAction: "none" }),
      card({ bookingId: "C", state: "needs_follow_up", nextAction: "call" }),
    ];
    const { groups, activeTotal } = buildServiceWorklist(cards);
    expect(activeTotal).toBe(1);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("reach_out");
  });

  it("counts overdue cards within each group without dropping them from the count", () => {
    const cards: PostEventCard[] = [
      card({ bookingId: "A", nextAction: "call", overdue: true }),
      card({ bookingId: "B", nextAction: "call", overdue: false }),
      card({ bookingId: "C", nextAction: "call", overdue: true }),
    ];
    const { groups } = buildServiceWorklist(cards);
    const reach = groups.find((g) => g.key === "reach_out")!;
    expect(reach.count).toBe(3);
    expect(reach.overdue).toBe(2);
    // Overdue reach-outs deep-link to the overdue queue filter.
    expect(reach.href).toContain("queue=overdue");
  });

  it("frames the confirmation queue supportively — never as lost or dissatisfied customers", () => {
    const { groups } = buildServiceWorklist([card({ bookingId: "A", state: "customer_responded", nextAction: "review_feedback" })]);
    const confirm = groups.find((g) => g.key === "confirm")!;
    expect(confirm.label).toBe("Confirm experience");
    expect(confirm.description.toLowerCase()).toContain("not lost");
    expect(confirm.description.toLowerCase()).not.toContain("dissatisf");
    expect(confirm.tone).toBe("info");
  });

  it("returns no groups for an empty board", () => {
    const { groups, activeTotal } = buildServiceWorklist([]);
    expect(groups).toEqual([]);
    expect(activeTotal).toBe(0);
  });
});
