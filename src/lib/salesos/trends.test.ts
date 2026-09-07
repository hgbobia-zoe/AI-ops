import { describe, it, expect } from "vitest";
import { seasonTrends, classifyEventType, typeTrends, regionOf, areaTrends, type TrendInput } from "./trends";

const won = (o: Partial<TrendInput>): TrendInput => ({ signed: true, statusLabel: "Contract Signed", grandTotal: 1000, ...o });
const lost = (o: Partial<TrendInput>): TrendInput => ({ signed: false, statusLabel: "Lost", grandTotal: 1000, ...o });

describe("trends — seasonTrends", () => {
  it("aggregates win/loss + booked revenue by month across years", () => {
    const s = seasonTrends([
      won({ eventDate: "2025-06-10", grandTotal: 2000 }),
      lost({ eventDate: "2026-06-20" }),
      won({ eventDate: "2024-06-01", grandTotal: 3000 }),
      won({ eventDate: "2025-12-25", grandTotal: 500 }),
      { signed: false, statusLabel: "Quote Sent", eventDate: "2026-06-01" }, // open → excluded
    ]);
    const jun = s[5];
    expect(jun.won).toBe(2);
    expect(jun.lost).toBe(1);
    expect(jun.winRate).toBeCloseTo(2 / 3);
    expect(jun.revenue).toBe(5000); // won June revenue across 2024+2025
    expect(s[11].revenue).toBe(500); // December
    expect(s).toHaveLength(12);
  });
});

describe("trends — event type inference", () => {
  it("classifies from the event name, order wedding→corporate→social→other", () => {
    expect(classifyEventType("Ashford Wedding — 200 guest tent")).toBe("wedding");
    expect(classifyEventType("Meridian Corp Holiday Party")).toBe("corporate"); // has 'party' but corporate wins
    expect(classifyEventType("Okafor 50th Birthday")).toBe("social");
    expect(classifyEventType("550 Morse St NE delivery")).toBe("other");
    expect(classifyEventType("")).toBe("other");
  });

  it("computes win rate + avg won value per inferred type", () => {
    const t = typeTrends([
      won({ eventName: "Smith Wedding", grandTotal: 5000 }),
      lost({ eventName: "Jones wedding reception" }),
      won({ eventName: "Acme Corp Gala", grandTotal: 8000 }),
    ]);
    const wed = t.find((x) => x.type === "wedding")!;
    const corp = t.find((x) => x.type === "corporate")!;
    expect(wed.won).toBe(1);
    expect(wed.lost).toBe(1);
    expect(wed.winRate).toBeCloseTo(0.5);
    expect(wed.avgWonValue).toBe(5000);
    expect(corp.avgWonValue).toBe(8000);
  });
});

describe("trends — area", () => {
  it("parses DC/MD/VA from a location string, else Other", () => {
    expect(regionOf("Washington, DC 20002")).toBe("DC");
    expect(regionOf("Bethesda, MD 20817")).toBe("MD");
    expect(regionOf("Annandale, VA 22003")).toBe("VA");
    expect(regionOf("Somewhere, PA")).toBe("Other");
    expect(regionOf(null)).toBe("Other");
  });

  it("aggregates win/loss + revenue by region", () => {
    const a = areaTrends([
      won({ location: "Washington, DC 20002", grandTotal: 2000 }),
      lost({ location: "Washington, DC 20010" }),
      won({ location: "Bethesda, MD 20817", grandTotal: 4000 }),
    ]);
    const dc = a.find((x) => x.region === "DC")!;
    const md = a.find((x) => x.region === "MD")!;
    expect(dc.won).toBe(1);
    expect(dc.lost).toBe(1);
    expect(dc.winRate).toBeCloseTo(0.5);
    expect(dc.revenue).toBe(2000);
    expect(md.winRate).toBe(1);
    expect(md.revenue).toBe(4000);
  });
});
