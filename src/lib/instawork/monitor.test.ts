import { describe, it, expect } from "vitest";
import { checkInstaworkChanges, type Snapshot } from "./monitor";
import type { InstaworkShift } from "./types";

function gig(p: Partial<InstaworkShift> & { id: string }): InstaworkShift {
  return {
    id: p.id,
    name: p.name ?? "ZER",
    startsAt: p.startsAt ?? "2026-10-03T09:00:00-04:00",
    endsAt: p.endsAt ?? "2026-10-03T17:00:00-04:00",
    timezone: "America/New_York",
    position: p.position ?? "General Labor",
    basePrice: p.basePrice ?? 33,
    filled: p.filled ?? (p.workers?.length ?? 0),
    total: p.total ?? 1,
    locationName: "ZER",
    workers: p.workers ?? [],
    interestedPending: 0,
  };
}

const START = Date.parse("2026-10-03T09:00:00-04:00");
const snap = (g: InstaworkShift): Snapshot => ({ [g.id]: { filled: g.filled, workers: [...g.workers], startsAt: g.startsAt, position: g.position, name: g.name } });

describe("checkInstaworkChanges", () => {
  it("alerts when a booked worker drops off a gig AFTER start (no-show)", () => {
    const before = gig({ id: "g1", workers: ["Darren Green"] });
    const after = gig({ id: "g1", workers: [] });
    const { alerts } = checkInstaworkChanges(snap(before), [after], START + 3_600_000); // 1h after start
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/Darren Green/);
    expect(alerts[0]).toMatch(/NO-SHOW/);
  });

  it("alerts when a worker drops shortly BEFORE start (dropped), not a no-show", () => {
    const before = gig({ id: "g1", workers: ["Darren Green"] });
    const after = gig({ id: "g1", workers: [] });
    const { alerts } = checkInstaworkChanges(snap(before), [after], START - 3_600_000); // 1h before start
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/dropped/);
    expect(alerts[0]).not.toMatch(/NO-SHOW/);
  });

  it("does NOT alert for a drop far before start (too early to matter)", () => {
    const before = gig({ id: "g1", workers: ["Darren Green"] });
    const after = gig({ id: "g1", workers: [] });
    const { alerts } = checkInstaworkChanges(snap(before), [after], START - 24 * 3_600_000); // a day early
    expect(alerts).toHaveLength(0);
  });

  it("never alerts for a new gig or one that only GAINED a worker", () => {
    expect(checkInstaworkChanges({}, [gig({ id: "new", workers: [] })], START).alerts).toHaveLength(0);
    const before = gig({ id: "g1", workers: [] });
    const after = gig({ id: "g1", workers: ["New Pro"] });
    expect(checkInstaworkChanges(snap(before), [after], START).alerts).toHaveLength(0);
  });

  it("dedups: once the drop is persisted, the next run doesn't re-alert", () => {
    const before = gig({ id: "g1", workers: ["Darren Green"] });
    const after = gig({ id: "g1", workers: [] });
    const first = checkInstaworkChanges(snap(before), [after], START + 3_600_000);
    expect(first.alerts).toHaveLength(1);
    // Persist `next`, run again with the same current → no change → no alert.
    const second = checkInstaworkChanges(first.next, [after], START + 7_200_000);
    expect(second.alerts).toHaveLength(0);
  });
});
