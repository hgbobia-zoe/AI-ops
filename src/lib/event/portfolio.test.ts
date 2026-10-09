// Portfolio view-model tests — PURE. Verifies the summary buckets, filtering, sorting and grouping the
// /events portfolio relies on. No DB/net; rows are hand-built.

import { describe, it, expect } from "vitest";
import {
  daysUntil,
  summarizePortfolio,
  filterPortfolio,
  sortPortfolio,
  groupPortfolio,
  type PortfolioRow,
} from "./portfolio";
import type { EventCondition, EventRef } from "./types";
import type { LifecycleState } from "./machine";

const TODAY = "2026-10-09";

function ref(id: string, date: string | null): EventRef {
  return { id: id as unknown as EventRef["id"], displayName: `Event ${id}`, date, dateSource: date ? "booking" : null, customer: "C", contactId: null, venue: null };
}
function row(id: string, date: string | null, lifecycle: LifecycleState, condition: EventCondition, value: number | null = null): PortfolioRow {
  return { ref: ref(id, date), lifecycle, condition, value };
}

const ROWS: PortfolioRow[] = [
  row("1", "2026-10-09", "DISPATCHED", "ESCALATED", 1000), // today
  row("2", "2026-10-12", "PLANNING", "AT_RISK", 500), // +3
  row("3", "2026-10-20", "READY", "NORMAL", 2000), // +11
  row("4", "2026-10-07", "LIVE", "BLOCKED", 300), // overdue -2
  row("5", null, "BOOKED", "WATCH", null), // undated
];

describe("daysUntil", () => {
  it("computes whole-day diffs, tz-safe", () => {
    expect(daysUntil("2026-10-09", TODAY)).toBe(0);
    expect(daysUntil("2026-10-12", TODAY)).toBe(3);
    expect(daysUntil("2026-10-07", TODAY)).toBe(-2);
  });
  it("returns null for missing/invalid dates", () => {
    expect(daysUntil(null, TODAY)).toBeNull();
    expect(daysUntil("not-a-date", TODAY)).toBeNull();
  });
});

describe("summarizePortfolio", () => {
  it("counts the overlapping summary buckets", () => {
    const s = summarizePortfolio(ROWS, TODAY);
    expect(s.total).toBe(5);
    expect(s.today).toBe(1); // row 1
    expect(s.next7).toBe(2); // row 1 (0) + row 2 (+3); row 4 is overdue, row 3 is +11
    expect(s.atRisk).toBe(2); // AT_RISK (row 2) + ESCALATED (row 1)
    expect(s.blocked).toBe(1); // row 4
    expect(s.ready).toBe(1); // row 3 lifecycle READY
  });
  it("empty rows -> all zero", () => {
    expect(summarizePortfolio([], TODAY)).toEqual({ total: 0, today: 0, next7: 0, atRisk: 0, blocked: 0, ready: 0 });
  });
});

describe("filterPortfolio", () => {
  it("filters by lifecycle", () => {
    expect(filterPortfolio(ROWS, { lifecycle: "READY" }, TODAY).map((r) => r.ref.id)).toEqual(["3"]);
  });
  it("filters by condition", () => {
    expect(filterPortfolio(ROWS, { condition: "BLOCKED" }, TODAY).map((r) => r.ref.id)).toEqual(["4"]);
  });
  it("window=overdue keeps only past-dated rows (undated excluded)", () => {
    expect(filterPortfolio(ROWS, { window: "overdue" }, TODAY).map((r) => r.ref.id)).toEqual(["4"]);
  });
  it("window=next7 excludes undated + out-of-window", () => {
    expect(filterPortfolio(ROWS, { window: "next7" }, TODAY).map((r) => r.ref.id).sort()).toEqual(["1", "2"]);
  });
  it("'all' sentinels are no-ops", () => {
    expect(filterPortfolio(ROWS, { lifecycle: "all", condition: "all", window: "all" }, TODAY)).toHaveLength(5);
  });
});

describe("sortPortfolio", () => {
  it("soonest first, undated last, worst-condition breaks ties", () => {
    const sorted = sortPortfolio(ROWS, TODAY).map((r) => r.ref.id);
    expect(sorted).toEqual(["4", "1", "2", "3", "5"]);
  });
  it("does not mutate the input", () => {
    const copy = [...ROWS];
    sortPortfolio(ROWS, TODAY);
    expect(ROWS).toEqual(copy);
  });
});

describe("groupPortfolio", () => {
  it("none -> single group", () => {
    const g = groupPortfolio(ROWS, "none", TODAY);
    expect(g).toHaveLength(1);
    expect(g[0].rows).toHaveLength(5);
  });
  it("by window, soonest bucket first, empties dropped", () => {
    const g = groupPortfolio(ROWS, "window", TODAY);
    expect(g.map((x) => x.key)).toEqual(["overdue", "today", "next7", "next30", "undated"]);
  });
  it("by condition, worst-first", () => {
    const g = groupPortfolio(ROWS, "condition", TODAY);
    expect(g.map((x) => x.key)).toEqual(["ESCALATED", "BLOCKED", "AT_RISK", "WATCH", "NORMAL"]);
  });
  it("by lifecycle, in happy-path order", () => {
    const g = groupPortfolio(ROWS, "lifecycle", TODAY);
    expect(g.map((x) => x.key)).toEqual(["BOOKED", "PLANNING", "READY", "DISPATCHED", "LIVE"]);
  });
});
