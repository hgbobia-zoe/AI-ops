import { describe, it, expect } from "vitest";
import {
  validateManualCost,
  manualCostEntry,
  estimateTransportCost,
  estimateOvertimePremium,
  detectExtraTrips,
  isLaborCascadeRef,
  MANUAL_COST_TYPES,
} from "./costFamilies";

describe("validateManualCost (G9)", () => {
  it("accepts a valid entry, rounds the amount, trims the note", () => {
    const r = validateManualCost({ eventId: " 123 ", type: "sub_rental", class: "DIRECT", amount: 100.009, note: "  Acme tent  " });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ eventId: "123", type: "sub_rental", klass: "DIRECT", amount: 100.01, note: "Acme tent" });
    }
  });
  it("rejects an empty project id", () => expect(validateManualCost({ eventId: "", type: "other", class: "DIRECT", amount: 1 }).ok).toBe(false));
  it("rejects labor (labor is derived-only, never hand-keyed)", () => {
    const r = validateManualCost({ eventId: "1", type: "labor", class: "DIRECT", amount: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_type");
  });
  it("rejects an unknown class and a non-finite amount", () => {
    expect(validateManualCost({ eventId: "1", type: "other", class: "WHATEVER", amount: 1 }).ok).toBe(false);
    expect(validateManualCost({ eventId: "1", type: "other", class: "DIRECT", amount: null }).ok).toBe(false);
    expect(validateManualCost({ eventId: "1", type: "other", class: "DIRECT", amount: Number.NaN }).ok).toBe(false);
  });
  it("allows a negative amount (a correction/refund is a real figure)", () =>
    expect(validateManualCost({ eventId: "1", type: "other", class: "DIRECT", amount: -50 }).ok).toBe(true));
  it("sub_rental is in the allowed set (G4 is populated via the manual path)", () =>
    expect((MANUAL_COST_TYPES as readonly string[]).includes("sub_rental")).toBe(true));
});

describe("manualCostEntry (G9)", () => {
  it("builds an ACTUAL source='manual' row keyed by the given source_ref", () => {
    const r = manualCostEntry({ eventId: "99", type: "sub_rental", klass: "DIRECT", amount: 250, note: "20x40 tent" }, "manual:99:abc", "Pat (Owner)");
    expect(r.type).toBe("sub_rental");
    expect(r.amountStatus).toBe("ACTUAL");
    expect(r.source).toBe("manual");
    expect(r.sourceRef).toBe("manual:99:abc");
    expect(r.eventId).toBe("99");
    expect(r.amount).toBe(250);
    expect(r.note).toContain("Pat (Owner)");
  });
});

describe("estimateTransportCost (G6) — distance × cost/mile, ESTIMATED, never a fake 0", () => {
  it("costs a geocodable leg and OMITS an un-geocoded one (UNAVAILABLE, not 0)", () => {
    const rows = estimateTransportCost({
      routeId: "R1",
      day: "2026-06-01",
      costPerMile: 0.7,
      legs: [
        { eventId: "A", roundTripMiles: 30 },
        { eventId: "B", roundTripMiles: null }, // not geocodable → no row
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].eventId).toBe("A");
    expect(rows[0].type).toBe("fuel");
    expect(rows[0].amount).toBe(21); // 30 * 0.7
    expect(rows[0].amountStatus).toBe("ESTIMATED");
    expect(rows[0].sourceRef).toBe("fuel:R1:A:2026-06-01");
  });
  it("emits nothing when the cost-per-mile knob is 0 (family disabled, not zeroed)", () =>
    expect(estimateTransportCost({ routeId: "R1", day: "d", costPerMile: 0, legs: [{ eventId: "A", roundTripMiles: 30 }] })).toHaveLength(0));
});

describe("estimateOvertimePremium (G8) — premium delta only, penny-true, no double-count", () => {
  it("splits the premium across projects by labor share and sums to the premium total", () => {
    const rows = estimateOvertimePremium({
      workerRef: "ct:7",
      periodStart: "2026-06-01",
      periodEnd: "2026-06-07",
      overtimeHours: 4,
      rate: 20,
      premiumMultiplier: 0.5, // premium = 4 * 20 * 0.5 = 40
      shares: [
        { eventId: "A", laborCost: 300 },
        { eventId: "B", laborCost: 100 },
      ],
    });
    expect(rows).toHaveLength(2);
    const sum = Math.round(rows.reduce((a, r) => a + (r.amount ?? 0), 0) * 100) / 100;
    expect(sum).toBe(40);
    expect(rows.find((r) => r.eventId === "A")!.amount).toBe(30); // 40 * 300/400
    expect(rows.find((r) => r.eventId === "B")!.amount).toBe(10);
    // premium rows are NOT labor-typed and never collide with the cascade's source_refs
    for (const r of rows) {
      expect(r.type).toBe("other");
      expect(isLaborCascadeRef(r.sourceRef)).toBe(false);
      expect(r.sourceRef.startsWith("ot-premium:ct:7:")).toBe(true);
    }
  });
  it("emits nothing when OT, rate, or shares are missing (UNAVAILABLE, not 0)", () => {
    const base = { workerRef: "ct:1", periodStart: "s", periodEnd: "e", premiumMultiplier: 0.5, shares: [{ eventId: "A", laborCost: 100 }] };
    expect(estimateOvertimePremium({ ...base, overtimeHours: null, rate: 20 })).toHaveLength(0);
    expect(estimateOvertimePremium({ ...base, overtimeHours: 4, rate: null })).toHaveLength(0);
    expect(estimateOvertimePremium({ ...base, overtimeHours: 4, rate: 20, shares: [] })).toHaveLength(0);
    expect(estimateOvertimePremium({ ...base, overtimeHours: 4, rate: 20, shares: [{ eventId: "A", laborCost: 0 }] })).toHaveLength(0);
  });
});

describe("detectExtraTrips (G7) — first trip is baseline, later same-kind is a costed extra", () => {
  const first = (m: Record<string, string>) => (eventId: string, kind: string) => m[`${eventId}|${kind}`] ?? null;
  it("does NOT cost a project's first delivery; costs a later delivery", () => {
    const rows = detectExtraTrips({
      costPerMile: 0.7,
      firstKindDate: first({ "A|delivery": "2026-06-01", "A|pickup": "2026-06-03" }),
      trips: [
        { eventId: "A", day: "2026-06-01", kind: "delivery", roundTripMiles: 30 }, // first delivery → baseline
        { eventId: "A", day: "2026-06-02", kind: "delivery", roundTripMiles: 30 }, // repeat delivery → extra
        { eventId: "A", day: "2026-06-03", kind: "pickup", roundTripMiles: 30 }, // first pickup → baseline
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].day).toBe("2026-06-02");
    expect(rows[0].type).toBe("event_expense");
    expect(rows[0].amount).toBe(21);
    expect(rows[0].amountStatus).toBe("ESTIMATED");
    expect(rows[0].sourceRef).toBe("extra-trip:A:2026-06-02:delivery");
  });
  it("detects an extra trip but does not cost it when distance is unknown (omit, never 0)", () => {
    const rows = detectExtraTrips({
      costPerMile: 0.7,
      firstKindDate: first({ "A|delivery": "2026-06-01" }),
      trips: [{ eventId: "A", day: "2026-06-05", kind: "delivery", roundTripMiles: null }],
    });
    expect(rows).toHaveLength(0);
  });
});

describe("no double-count: derived families never masquerade as cascade labor", () => {
  it("transport/extra-trip/overtime use distinct types and source_ref prefixes from labor", () => {
    const all = [
      ...estimateTransportCost({ routeId: "R", day: "d", costPerMile: 0.7, legs: [{ eventId: "A", roundTripMiles: 10 }] }),
      ...detectExtraTrips({ costPerMile: 0.7, firstKindDate: () => "2026-01-01", trips: [{ eventId: "A", day: "2026-02-01", kind: "delivery", roundTripMiles: 10 }] }),
      ...estimateOvertimePremium({ workerRef: "ct:1", periodStart: "s", periodEnd: "e", overtimeHours: 2, rate: 20, premiumMultiplier: 0.5, shares: [{ eventId: "A", laborCost: 100 }] }),
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const r of all) {
      expect(r.type).not.toBe("labor");
      expect(isLaborCascadeRef(r.sourceRef)).toBe(false);
    }
  });
});
