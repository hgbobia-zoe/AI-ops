import { describe, it, expect } from "vitest";
import { normalizeCategory, dedupeKeyFor, type RawEventRecord } from "./ingest";
import { normalizeRegion } from "./geo";

describe("normalizeCategory", () => {
  it("maps canonical keys and free-form text", () => {
    expect(normalizeCategory("Trade show")).toBe("TRADE_SHOW");
    expect(normalizeCategory("Medical conference")).toBe("MEDICAL");
    expect(normalizeCategory("annual meeting of the society")).toBe("ASSOCIATION_MEETING");
    expect(normalizeCategory("summit")).toBe("CONFERENCE");
    expect(normalizeCategory("something odd")).toBe("OTHER");
    expect(normalizeCategory(undefined)).toBe("OTHER");
  });
});

describe("dedupeKeyFor", () => {
  it("prefers externalId and is stable", () => {
    const r: RawEventRecord = { externalId: "x1", name: "A" };
    expect(dedupeKeyFor("src", r)).toBe("src:x1");
    expect(dedupeKeyFor("src", r)).toBe(dedupeKeyFor("src", r));
  });
  it("derives a slug key without externalId", () => {
    const r: RawEventRecord = { name: "CHD Conference 2027", startDate: "2027-09-17", city: "Washington" };
    expect(dedupeKeyFor("src", r)).toMatch(/^src:chd-conference-2027-2027-09-17-washington$/);
  });
});

describe("normalizeRegion (geography)", () => {
  it("classifies DMV sub-areas", () => {
    expect(normalizeRegion({ city: "Washington", state: "DC" })).toBe("DC");
    expect(normalizeRegion({ city: "Bethesda", state: "MD" })).toBe("MONTGOMERY_MD");
    expect(normalizeRegion({ city: "National Harbor", state: "MD" })).toBe("PRINCE_GEORGES_MD");
    expect(normalizeRegion({ city: "McLean", state: "VA" })).toBe("NOVA");
    expect(normalizeRegion({ city: "Baltimore", state: "MD" })).toBe("BALTIMORE");
    expect(normalizeRegion({ city: "Columbia", state: "MD" })).toBe("HOWARD_MD");
  });
  it("flags out-of-area and unknown honestly", () => {
    expect(normalizeRegion({ city: "New York", state: "NY" })).toBe("OUT_OF_AREA");
    expect(normalizeRegion({ city: "Online" })).toBe("UNKNOWN");
    expect(normalizeRegion({})).toBe("UNKNOWN");
  });
});
