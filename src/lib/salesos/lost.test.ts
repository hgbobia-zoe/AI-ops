import { describe, it, expect } from "vitest";
import { outcomeOf, winLossStats, winRateBySize, winLossByYear, reasonBreakdown, lossInsights, type LostInput } from "./lost";

const q = (o: Partial<LostInput>): LostInput => ({ signed: false, statusLabel: "Quote Sent", grandTotal: 1000, eventDate: "2026-06-01", ...o });

describe("lost — outcomeOf", () => {
  it("a lost/cancelled status is 'lost' even if it was once signed", () => {
    expect(outcomeOf({ signed: true, statusLabel: "Lost" })).toBe("lost");
    expect(outcomeOf({ signed: false, statusLabel: "Cancelled" })).toBe("lost");
  });
  it("signed & not-lost is 'won'; everything else is 'open'", () => {
    expect(outcomeOf({ signed: true, statusLabel: "Contract Signed" })).toBe("won");
    expect(outcomeOf({ signed: false, statusLabel: "Quote Sent" })).toBe("open");
    expect(outcomeOf({ signed: false, statusLabel: "New Project" })).toBe("open");
  });
});

describe("lost — winLossStats", () => {
  it("computes win rate over DECIDED quotes only (open excluded)", () => {
    const s = winLossStats([
      q({ signed: true, statusLabel: "Contract Signed", grandTotal: 2000 }),
      q({ signed: true, statusLabel: "Contract Signed", grandTotal: 4000 }),
      q({ signed: false, statusLabel: "Lost", grandTotal: 1000 }),
      q({ signed: false, statusLabel: "Quote Sent", grandTotal: 5000 }), // open → not in win rate
    ]);
    expect(s.won).toBe(2);
    expect(s.lost).toBe(1);
    expect(s.open).toBe(1);
    expect(s.decided).toBe(3);
    expect(s.winRate).toBeCloseTo(2 / 3);
    expect(s.wonValue).toBe(6000);
    expect(s.lostValue).toBe(1000);
    expect(s.avgWonValue).toBe(3000);
  });
  it("winRate is null when nothing is decided", () => {
    expect(winLossStats([q({ signed: false, statusLabel: "Quote Sent" })]).winRate).toBeNull();
  });
});

describe("lost — winRateBySize", () => {
  it("buckets decided quotes by value and computes per-bucket win rate", () => {
    const b = winRateBySize([
      q({ signed: true, statusLabel: "Contract Signed", grandTotal: 300 }), // Under $500 win
      q({ signed: false, statusLabel: "Lost", grandTotal: 400 }), // Under $500 loss
      q({ signed: true, statusLabel: "Contract Signed", grandTotal: 6000 }), // $5k+ win
      q({ signed: false, statusLabel: "Lost", grandTotal: 7000 }), // $5k+ loss
      q({ signed: false, statusLabel: "Lost", grandTotal: 8000 }), // $5k+ loss
      q({ signed: false, statusLabel: "Quote Sent", grandTotal: 400 }), // open → ignored
      q({ signed: true, statusLabel: "Contract Signed", grandTotal: null }), // no value → ignored
    ]);
    const under = b.find((x) => x.label === "Under $500")!;
    const big = b.find((x) => x.label === "$5k+")!;
    expect(under.won).toBe(1);
    expect(under.lost).toBe(1);
    expect(under.winRate).toBeCloseTo(0.5);
    expect(big.won).toBe(1);
    expect(big.lost).toBe(2);
    expect(big.winRate).toBeCloseTo(1 / 3);
  });
});

describe("lost — winLossByYear", () => {
  it("groups decided quotes by event-date year, ascending", () => {
    const y = winLossByYear([
      q({ signed: true, statusLabel: "Contract Signed", eventDate: "2025-03-01", grandTotal: 1000 }),
      q({ signed: false, statusLabel: "Lost", eventDate: "2025-07-01", grandTotal: 500 }),
      q({ signed: true, statusLabel: "Contract Signed", eventDate: "2026-01-01", grandTotal: 2000 }),
      q({ signed: false, statusLabel: "Quote Sent", eventDate: "2026-05-01" }), // open → excluded
      q({ signed: false, statusLabel: "Lost", eventDate: null }), // undated → excluded
    ]);
    expect(y.map((r) => r.year)).toEqual([2025, 2026]);
    expect(y[0]).toMatchObject({ year: 2025, won: 1, lost: 1, lostValue: 500 });
    expect(y[0].winRate).toBeCloseTo(0.5);
    expect(y[1]).toMatchObject({ year: 2026, won: 1, lost: 0 });
    expect(y[1].winRate).toBe(1);
  });
});

describe("lost — reasonBreakdown & insights", () => {
  it("separates tagged reasons from untagged, never hiding the unknown", () => {
    const r = reasonBreakdown([
      q({ statusLabel: "Lost", lossReason: "Price — too expensive", grandTotal: 1000 }),
      q({ statusLabel: "Lost", lossReason: "Price — too expensive", grandTotal: 500 }),
      q({ statusLabel: "Lost", lossReason: "Went with a competitor", grandTotal: 2000 }),
      q({ statusLabel: "Lost", lossReason: null }),
      q({ statusLabel: "Lost", lossReason: "  " }), // blank → untagged
    ]);
    expect(r.untaggedCount).toBe(2);
    expect(r.tagged[0]).toMatchObject({ reason: "Price — too expensive", count: 2, value: 1500 });
    expect(r.tagged).toHaveLength(2);
  });

  it("flags the biggest size-based leak and prompts tagging when no reasons exist", () => {
    const bookings: LostInput[] = [];
    for (let i = 0; i < 12; i++) bookings.push(q({ signed: true, statusLabel: "Contract Signed", grandTotal: 300 })); // small: all won
    for (let i = 0; i < 12; i++) bookings.push(q({ signed: false, statusLabel: "Lost", grandTotal: 6000 })); // big: all lost
    const stats = winLossStats(bookings);
    const buckets = winRateBySize(bookings);
    const reasons = reasonBreakdown(bookings.filter((b) => outcomeOf(b) === "lost"));
    const ins = lossInsights(stats, buckets, reasons);
    expect(ins.some((i) => i.tone === "warn" && /biggest leak/.test(i.text))).toBe(true);
    expect(ins.some((i) => /tag why quotes were lost/i.test(i.text))).toBe(true);
  });
});
