import { describe, it, expect } from "vitest";
import { peakItemDemand, normalizeItem, type ItemStop } from "./inventory";

describe("inventory concurrent demand", () => {
  it("normalizes near-duplicate item names", () => {
    expect(normalizeItem("40x60  Tent")).toBe("40x60 tent");
    expect(normalizeItem("40X60 TENT")).toBe("40x60 tent");
  });

  it("sums same-day concurrent quantity across events and reports the peak day", () => {
    const stops: ItemStop[] = [
      { date: "2026-09-12", eventId: "A", items: [{ name: "Chiavari Chair", quantity: 200 }] },
      { date: "2026-09-12", eventId: "B", items: [{ name: "chiavari chair", quantity: 150 }] }, // same day, diff event
      { date: "2026-09-20", eventId: "C", items: [{ name: "Chiavari Chair", quantity: 100 }] },
    ];
    const peaks = peakItemDemand(stops);
    const chairs = peaks.find((p) => normalizeItem(p.name) === "chiavari chair")!;
    expect(chairs.peakQty).toBe(350); // 200 + 150 on 9/12
    expect(chairs.peakDate).toBe("2026-09-12");
    expect(chairs.daysWithDemand).toBe(2);
  });

  it("counts an event's line once even if it appears twice on a date", () => {
    const stops: ItemStop[] = [
      { date: "2026-09-12", eventId: "A", items: [{ name: "Tent", quantity: 1 }] },
      { date: "2026-09-12", eventId: "A", items: [{ name: "Tent", quantity: 1 }] }, // same event, dup
    ];
    expect(peakItemDemand(stops)[0].peakQty).toBe(1); // not 2
  });
});
