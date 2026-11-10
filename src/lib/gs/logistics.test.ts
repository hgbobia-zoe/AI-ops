import { describe, expect, it } from "vitest";
import { parseLegLabel, parseProjectLogistics } from "./logistics";

// Shapes copied from live Goodshuffle timelines (2026-11-10), no client data.
describe("parseProjectLogistics", () => {
  it("drop-off is the earliest delivery leg, pickup the latest", () => {
    const l = parseProjectLogistics(
      [
        { type: "lineItemGroup", dateLabel: "Nov 20 - Nov 21, 2026" },
        { type: "logisticsDelivery", dateLabel: "Monday, 11/23 [9:00 AM - 8:00 PM]" },
        { type: "logisticsDelivery", dateLabel: "Thursday, 11/19 [3:00 PM - 5:00 PM]" },
      ],
      "2026-11-19",
    );
    expect(l).toEqual({
      deliveryDate: "2026-11-19",
      deliveryWindow: "3:00 PM - 5:00 PM",
      pickupDate: "2026-11-23",
      pickupWindow: "9:00 AM - 8:00 PM",
      delivers: true,
    });
  });

  it("same-day drop-off and pickup", () => {
    const l = parseProjectLogistics(
      [
        { type: "logisticsDelivery", dateLabel: "Saturday, 11/14 [8:30 AM - 9:00 AM]" },
        { type: "logisticsDelivery", dateLabel: "Saturday, 11/14 [2:30 PM - 3:00 PM]" },
      ],
      "2026-11-14",
    );
    expect(l.deliveryDate).toBe("2026-11-14");
    expect(l.pickupDate).toBe("2026-11-14");
    expect(l.deliveryWindow).toBe("8:30 AM - 9:00 AM");
  });

  it("in-store only means we never drive there", () => {
    const l = parseProjectLogistics(
      [
        { type: "logisticsInStore", dateLabel: "Saturday, 11/28 [10:00 AM - 1:00 PM]" },
        { type: "logisticsInStore", dateLabel: "Monday, 11/30 [10:00 AM - 4:00 PM]" },
      ],
      "2026-11-28",
    );
    expect(l.delivers).toBe(false);
    expect(l.deliveryDate).toBeNull();
    expect(l.pickupDate).toBeNull();
  });

  it("we deliver, the customer returns in store: no pickup leg", () => {
    const l = parseProjectLogistics(
      [
        { type: "logisticsDelivery", dateLabel: "Friday, 11/13 [9:00 AM - 12:00 PM]" },
        { type: "logisticsInStore", dateLabel: "Monday, 11/16 [10:00 AM - 4:00 PM]" },
      ],
      "2026-11-13",
    );
    expect(l.delivers).toBe(true);
    expect(l.deliveryDate).toBe("2026-11-13");
    expect(l.pickupDate).toBeNull();
  });

  it("no logistics legs at all is unknown, not false", () => {
    expect(parseProjectLogistics([{ type: "lineItemGroup", dateLabel: "Nov 14, 2026" }], "2026-11-14").delivers).toBeNull();
    expect(parseProjectLogistics([], null).delivers).toBeNull();
  });

  it("rolls the year across New Year", () => {
    expect(parseLegLabel("Saturday, 1/2 [9:00 AM - 5:00 PM]", "2026-12-30")?.date).toBe("2027-01-02");
    expect(parseLegLabel("Friday, 4/9 [10:00 AM - 12:00 PM]", "2027-04-09")?.date).toBe("2027-04-09");
    expect(parseLegLabel("no date here", "2027-04-09")).toBeNull();
  });
});
