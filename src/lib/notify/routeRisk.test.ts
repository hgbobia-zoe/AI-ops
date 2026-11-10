import { describe, expect, it, vi } from "vitest";

vi.mock("./slack", () => ({ slackNotify: vi.fn(async () => ({ ok: true })) }));

import { formatStackAlert } from "./routeRisk";
import { stackingWarnings } from "@/lib/dispatch/onTime";

describe("formatStackAlert (sequencing check Slack copy)", () => {
  const exactLate = stackingWarnings([
    { stopId: "M", sequence: 1, custName: "Montealegre", windowStart: "2026-10-31T13:00:00.000Z", windowEnd: "2026-10-31T14:00:00.000Z", pinPoint: true, plannedArrival: "2026-10-31T14:40:00.000Z", plannedOnSiteMin: 115, plannedTransitMin: 13 },
    { stopId: "G", sequence: 2, custName: "McGahn", windowStart: "2026-10-31T13:00:00.000Z", windowEnd: "2026-10-31T15:00:00.000Z", plannedArrival: "2026-10-31T16:35:00.000Z", plannedOnSiteMin: 60, plannedTransitMin: 28 },
  ]);

  it("says the stops arrive after the window closes and puts a paid exact time first", () => {
    expect(exactLate).toHaveLength(2);
    const text = formatStackAlert("NPR-1", "2026-10-31", exactLate);
    expect(text).toContain("2 stops are planned to arrive after the customer window closes.");
    expect(text).toContain("One is a paid exact time window. Fix that one first.");
    expect(text).toContain("• Exact time. Montealegre is planned for 10:40 AM");
    // House style: no dashes or emoji in the body (the date in the header is data).
    expect(text.split("\n").slice(1).join("\n")).not.toMatch(/[–—-]/);
  });

  it("is honest when Goodshuffle only has the window start", () => {
    const w = stackingWarnings([
      { stopId: "P", sequence: 1, custName: "Palmer", windowStart: "2026-10-30T13:00:00.000Z", plannedArrival: "2026-10-30T15:05:00.000Z", plannedOnSiteMin: 50 },
    ]);
    const text = formatStackAlert("E450", "2026-10-30", w);
    expect(text).toContain("Goodshuffle has no window end for it, so check with the customer.");
    expect(text).not.toContain("closes");
  });
});
