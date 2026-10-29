import { describe, it, expect } from "vitest";
import {
  buildAttention,
  summarize,
  opsBrief,
  filterAttention,
  groupAttention,
  dateBucketOf,
  ownersOf,
  UNASSIGNED,
  type OpsInputs,
  type AttentionItem,
} from "./manager";

const base: OpsInputs = { risks: [], nearTermGaps: [], dormantCount: 0 };

describe("ops manager — attention ranking", () => {
  it("ranks a critical imminent risk above a high one far out", () => {
    const items = buildAttention({
      ...base,
      risks: [
        { severity: "HIGH", title: "High far", description: "d", signature: "h1", daysUntil: 20 },
        { severity: "CRITICAL", title: "Critical soon", description: "d", signature: "c1", daysUntil: 1 },
      ],
    });
    expect(items[0].title).toBe("Critical soon");
    expect(items[0].priority).toBe("critical");
    expect(items[0].score).toBeGreaterThan(items[1].score);
  });

  it("adds sales gaps, labor overruns, and win-back as their own items", () => {
    const items = buildAttention({
      risks: [],
      nearTermGaps: [{ label: "Sep 6 – 12" }],
      labor: { verified: true, costVarianceValue: 500, costVariancePct: 0.2, favorable: false, alertPct: 0.1 },
      dormantCount: 3,
    });
    expect(items.find((i) => i.source === "sales")).toBeTruthy();
    expect(items.find((i) => i.source === "finance")?.title).toContain("20%");
    expect(items.find((i) => i.source === "customer")?.title).toContain("3 repeat customers");
  });

  it("does NOT raise a labor item when unverified or within threshold or favorable", () => {
    const unverified = buildAttention({ ...base, labor: { verified: false, costVarianceValue: 999, costVariancePct: 0.9, favorable: false, alertPct: 0.1 } });
    expect(unverified.find((i) => i.source === "finance")).toBeFalsy();
    const withinThreshold = buildAttention({ ...base, labor: { verified: true, costVarianceValue: 10, costVariancePct: 0.05, favorable: false, alertPct: 0.1 } });
    expect(withinThreshold.find((i) => i.source === "finance")).toBeFalsy();
    const favorable = buildAttention({ ...base, labor: { verified: true, costVarianceValue: -500, costVariancePct: -0.2, favorable: true, alertPct: 0.1 } });
    expect(favorable.find((i) => i.source === "finance")).toBeFalsy();
  });

  it("weights by financial impact — same severity, bigger booking ranks higher", () => {
    const items = buildAttention({
      ...base,
      risks: [
        { severity: "MEDIUM", title: "small", description: "d", signature: "s1", daysUntil: 5, revenue: 200 },
        { severity: "MEDIUM", title: "big", description: "d", signature: "s2", daysUntil: 5, revenue: 15000 },
      ],
    });
    expect(items[0].title).toBe("big"); // $15k MEDIUM outranks $200 MEDIUM
    expect(items[0].score).toBeGreaterThan(items[1].score);
  });

  it("a high-value repeat customer adds a small nudge", () => {
    const plain = buildAttention({ ...base, risks: [{ severity: "MEDIUM", title: "x", description: "d", signature: "s", daysUntil: 5 }] });
    const vip = buildAttention({ ...base, risks: [{ severity: "MEDIUM", title: "x", description: "d", signature: "s", daysUntil: 5, highValueCustomer: true }] });
    expect(vip[0].score).toBeGreaterThan(plain[0].score);
  });

  it("summarize + brief reflect the counts, and an empty feed reads as all-clear", () => {
    const empty = buildAttention(base);
    expect(summarize(empty).total).toBe(0);
    expect(opsBrief(empty, summarize(empty))).toContain("Nothing needs attention");

    const items = buildAttention({ ...base, risks: [{ severity: "CRITICAL", title: "X", description: "d", signature: "s", daysUntil: 0 }] });
    const sum = summarize(items);
    expect(sum.critical).toBe(1);
    expect(opsBrief(items, sum)).toContain("critical");
    expect(opsBrief(items, sum)).toContain("Start with: X");
  });
});

describe("ops manager — enriched item anatomy (severity/status/owner/focus separated)", () => {
  it("carries severity, workflow status, owner and a why-ranked rationale", () => {
    const [item] = buildAttention({
      ...base,
      risks: [
        {
          severity: "HIGH",
          title: "Missing driver",
          description: "No driver assigned",
          recommendedAction: "Assign a driver",
          signature: "d1",
          date: "2026-11-02",
          daysUntil: 2,
          status: "ACKNOWLEDGED",
          owner: "Maria",
          actionTarget: "dispatch",
          affectedEntity: "Route 81",
        },
      ],
    });
    expect(item.severity).toBe("high"); // intrinsic severity, separate from the ranking bucket
    expect(item.status).toBe("acknowledged"); // workflow status, separate again
    expect(item.owner).toBe("Maria");
    expect(item.nextAction).toBe("Assign a driver");
    expect(item.reasons.some((r) => /High severity/i.test(r))).toBe(true);
    expect(item.reasons.some((r) => /event tomorrow|in 2d/i.test(r))).toBe(true);
    // focused destination carries the affected date — never a bare /dispatch
    expect(item.focusHref).toBe("/dispatch?date=2026-11-02");
  });

  it("a capacity-constrained day focuses dispatch on that exact day", () => {
    const [item] = buildAttention({ ...base, capacityConstrained: [{ date: "2026-11-02", reasons: ["No driver"] }] });
    expect(item.source).toBe("risk");
    expect(item.focusHref).toBe("/dispatch?date=2026-11-02");
    expect(item.date).toBe("2026-11-02");
  });

  it("never leaks a dollar figure into a risk item's ranking reasons", () => {
    const [item] = buildAttention({
      ...base,
      risks: [{ severity: "MEDIUM", title: "x", description: "d", signature: "s", daysUntil: 5, revenue: 15000 }],
    });
    expect(item.reasons.join(" ")).not.toMatch(/\$|\d{3,}/);
    expect(item.reasons.some((r) => /booking value/i.test(r))).toBe(true);
  });
});

describe("ops manager — date buckets", () => {
  it("maps days-until to coarse buckets", () => {
    expect(dateBucketOf(null)).toBe("undated");
    expect(dateBucketOf(undefined)).toBe("undated");
    expect(dateBucketOf(-1)).toBe("overdue");
    expect(dateBucketOf(0)).toBe("today");
    expect(dateBucketOf(3)).toBe("soon");
    expect(dateBucketOf(7)).toBe("week");
    expect(dateBucketOf(8)).toBe("later");
  });
});

function sample(): AttentionItem[] {
  return buildAttention({
    ...base,
    risks: [
      { severity: "CRITICAL", title: "A", description: "d", signature: "a", date: "2026-11-02", daysUntil: 0, owner: "Maria" },
      { severity: "HIGH", title: "B", description: "d", signature: "b", date: "2026-11-02", daysUntil: 0 },
      { severity: "MEDIUM", title: "C", description: "d", signature: "c", date: "2026-11-05", daysUntil: 3, owner: "Sam" },
    ],
    dormantCount: 2, // an undated, ownerless info item
  });
}

describe("ops manager — filtering", () => {
  it("filters by priority, date bucket and owner independently", () => {
    const items = sample();
    expect(filterAttention(items, { priority: "critical" }).map((i) => i.title)).toEqual(["A"]);
    expect(filterAttention(items, { dateBucket: "today" }).map((i) => i.title).sort()).toEqual(["A", "B"]);
    expect(filterAttention(items, { dateBucket: "undated" }).every((i) => i.source === "customer")).toBe(true);
    expect(filterAttention(items, { owner: "Maria" }).map((i) => i.title)).toEqual(["A"]);
    expect(filterAttention(items, { owner: UNASSIGNED }).some((i) => i.title === "B")).toBe(true);
  });

  it("'all' sentinels are no-ops", () => {
    const items = sample();
    expect(filterAttention(items, { priority: null, dateBucket: "all", owner: "all" }).length).toBe(items.length);
  });

  it("lists distinct owners and flags unassigned presence", () => {
    const { owners, hasUnassigned } = ownersOf(sample());
    expect(owners).toEqual(["Maria", "Sam"]);
    expect(hasUnassigned).toBe(true);
  });
});

describe("ops manager — grouping related same-day signals", () => {
  it("clusters 2+ signals on the same day but keeps single-signal days standalone", () => {
    const groups = groupAttention(sample());
    const day = groups.find((g) => g.kind === "day");
    expect(day?.date).toBe("2026-11-02");
    expect(day?.items.map((i) => i.title).sort()).toEqual(["A", "B"]); // both children retained
    // the Nov 5 item and the undated info item stay as standalone singles
    expect(groups.filter((g) => g.kind === "single").length).toBe(2);
  });

  it("never drops or reorders below the top score — groups ordered by highest child", () => {
    const items = sample();
    const groups = groupAttention(items);
    const totalChildren = groups.reduce((n, g) => n + g.items.length, 0);
    expect(totalChildren).toBe(items.length); // nothing dropped
    // first group leads with the highest-scoring item overall
    expect(groups[0].topScore).toBe(Math.max(...items.map((i) => i.score)));
  });
});
