import { describe, it, expect } from "vitest";
import { classifyZoeCategories, isEventRelevant, roleForEntityKind, pickPrimaryTargetRole } from "./classify";
import { normalizeJurisdiction } from "./jurisdiction";

describe("classifyZoeCategories", () => {
  it("detects rental categories from text, deduped", () => {
    const cats = classifyZoeCategories("Need a tent, tables and chairs plus a dance floor and staging");
    expect(cats).toEqual(expect.arrayContaining(["tent", "tables", "chairs", "dance_floor", "staging"]));
  });
  it("returns empty when nothing matches", () => {
    expect(classifyZoeCategories("software licensing renewal")).toEqual([]);
  });
});

describe("isEventRelevant", () => {
  it("is true for event-adjacent text", () => {
    expect(isEventRelevant("Annual gala reception with catering")).toBe(true);
    expect(isEventRelevant("tent rental for festival")).toBe(true);
  });
  it("is false for clearly unrelated text", () => {
    expect(isEventRelevant("IT help desk staffing contract")).toBe(false);
  });
});

describe("pickPrimaryTargetRole", () => {
  it("prefers the commercial path (event mgmt / planner) over the government buyer", () => {
    expect(pickPrimaryTargetRole(["DIRECT_BUYER", "EVENT_MGMT", "VENDOR"])).toBe("EVENT_MGMT");
    expect(pickPrimaryTargetRole(["DIRECT_BUYER", "PRIME_CONTRACTOR"])).toBe("PRIME_CONTRACTOR");
    expect(pickPrimaryTargetRole([])).toBeNull();
  });
  it("maps entity kinds to sensible default roles", () => {
    expect(roleForEntityKind("AGENCY")).toBe("DIRECT_BUYER");
    expect(roleForEntityKind("EVENT_PLANNER")).toBe("EVENT_PLANNER");
    expect(roleForEntityKind("PRIME")).toBe("PRIME_CONTRACTOR");
  });
});

describe("normalizeJurisdiction", () => {
  it("classifies from agency text first", () => {
    expect(normalizeJurisdiction({ agency: "Montgomery County Government" })).toBe("MONTGOMERY_CO");
    expect(normalizeJurisdiction({ agency: "City of Rockville" })).toBe("ROCKVILLE");
    expect(normalizeJurisdiction({ agency: "National Institutes of Health" })).toBe("FEDERAL");
  });
  it("falls back to region, else UNKNOWN", () => {
    expect(normalizeJurisdiction({ region: "DC" })).toBe("DC");
    expect(normalizeJurisdiction({ region: "OUT_OF_AREA" })).toBe("OTHER");
    expect(normalizeJurisdiction({})).toBe("UNKNOWN");
  });
});
