import { describe, it, expect } from "vitest";
import { settleTransitions, formatRiskUpdate, updateLines, cleanTitle, isAnnounceable, type PendingMap } from "./notify";
import type { StoredRisk } from "./store";

const risk = (over: Partial<StoredRisk> = {}): StoredRisk => ({
  id: "RK-1",
  signature: "driver_shortage|2026-11-06",
  riskType: "driver_shortage",
  category: "DRIVER",
  severity: "HIGH",
  status: "OPEN",
  title: "Not enough drivers scheduled (2026-11-06)",
  description: "",
  date: "2026-11-06",
  firstDetectedAt: "2026-11-01T00:00:00Z",
  lastSeenAt: "2026-11-02T00:00:00Z",
  ...over,
});
const NONE = { regressed: [] as StoredRisk[], resolved: [] as StoredRisk[] };
const T1 = "2026-11-02T18:06:00.000Z";
const T2 = "2026-11-02T18:08:00.000Z";
const T3 = "2026-11-02T19:06:00.000Z";
const TODAY = "2026-11-02";

describe("settleTransitions", () => {
  it("the hourly flap (Regressed then Resolved minutes later) posts nothing", () => {
    const a = settleTransitions({}, { ...NONE, regressed: [risk()] }, T1, TODAY);
    expect(a.ready).toEqual([]);
    const b = settleTransitions(a.pending, { ...NONE, resolved: [risk({ status: "RESOLVED" })] }, T2, TODAY);
    expect(b.ready).toEqual([]);
    expect(b.pending).toEqual({});
  });

  it("a regression that holds through the next scan posts once", () => {
    const a = settleTransitions({}, { ...NONE, regressed: [risk()] }, T1, TODAY);
    const b = settleTransitions(a.pending, NONE, T2, TODAY);
    expect(b.ready.map((r) => r.kind)).toEqual(["regressed"]);
    const c = settleTransitions(b.pending, NONE, T3, TODAY);
    expect(c.ready).toEqual([]);
  });

  it("a resolution that holds posts once", () => {
    const a = settleTransitions({}, { ...NONE, resolved: [risk({ status: "RESOLVED" })] }, T1, TODAY);
    expect(a.ready).toEqual([]);
    expect(settleTransitions(a.pending, NONE, T2, TODAY).ready.map((r) => r.kind)).toEqual(["resolved"]);
  });

  it("medium and low risks never post back/fixed", () => {
    const a = settleTransitions({}, { ...NONE, regressed: [risk({ severity: "MEDIUM" })] }, T1, TODAY);
    expect(a.pending).toEqual({});
  });

  it("'couldn't be verified' data gaps never post", () => {
    const gap = risk({ signature: "staffing_unverified|2026-11-06", riskType: "staffing_unverified", severity: "HIGH" });
    expect(settleTransitions({}, { ...NONE, regressed: [gap] }, T1, TODAY).pending).toEqual({});
  });

  it("drops pending items for days already past", () => {
    const pending: PendingMap = { old: { kind: "regressed", title: "x", date: "2026-11-01", severity: "HIGH", firstAt: T1 } };
    const r = settleTransitions(pending, NONE, T2, TODAY);
    expect(r.ready).toEqual([]);
    expect(r.pending).toEqual({});
  });
});

describe("cleanTitle", () => {
  it("drops the repeated date and the dash", () => {
    expect(cleanTitle("Not enough drivers scheduled (2026-11-06)", "2026-11-06")).toBe("Not enough drivers scheduled");
    expect(cleanTitle("Driver not scheduled — Joseph Hewitt", "2026-11-06")).toBe("Driver not scheduled: Joseph Hewitt");
  });
});

describe("isAnnounceable", () => {
  it("HIGH and CRITICAL only", () => {
    expect(isAnnounceable({ severity: "CRITICAL", riskType: "x" })).toBe(true);
    expect(isAnnounceable({ severity: "MEDIUM", riskType: "x" })).toBe(false);
  });
});

describe("formatRiskUpdate", () => {
  it("returns null when nothing to say", () => {
    expect(formatRiskUpdate([])).toBeNull();
  });

  it("groups by day, soonest first, action items before fixes, no dashes or repeated dates", () => {
    const text = formatRiskUpdate(
      updateLines(
        {
          created: [risk({ severity: "CRITICAL", title: "Driver not scheduled — Joseph Hewitt", date: "2026-11-07" })],
          escalated: [],
          regressed: [],
          resolved: [],
        },
        [
          { signature: "a", kind: "resolved", title: "Warehouse coverage short (2026-11-06)", date: "2026-11-06", severity: "HIGH", firstAt: T1 },
          { signature: "b", kind: "regressed", title: "Not enough drivers scheduled (2026-11-06)", date: "2026-11-06", severity: "HIGH", firstAt: T1 },
        ],
      ),
    )!;
    const lines = text.split("\n");
    expect(lines[0]).toBe("🧭 *Event Risk update*");
    expect(lines[1]).toMatch(/Nov 6/);
    expect(lines[2]).toBe("• Back: Not enough drivers scheduled (high)");
    expect(lines[3]).toBe("• Fixed: Warehouse coverage short");
    expect(lines[4]).toMatch(/Nov 7/);
    expect(lines[5]).toBe("• New: Driver not scheduled: Joseph Hewitt (critical)");
    expect(text).not.toMatch(/—|2026-11-0/);
  });

  it("caps the list and points to /risk", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ kind: "new" as const, title: `Risk ${i}`, date: "2026-11-06", severity: "HIGH" }));
    const text = formatRiskUpdate(many, 12)!;
    expect(text).toMatch(/and 3 more on \/risk$/);
  });

  it("medium new risks and medium escalations are left to /risk", () => {
    const lines = updateLines(
      { created: [risk({ severity: "MEDIUM" })], escalated: [{ risk: risk({ severity: "MEDIUM" }), from: "LOW", to: "MEDIUM" }], regressed: [], resolved: [] },
      [],
    );
    expect(lines).toEqual([]);
  });
});
