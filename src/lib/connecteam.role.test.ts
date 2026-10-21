import { describe, it, expect } from "vitest";
import { roleFromTitle, routeEligibleFromTitle } from "./connecteam";

describe("roleFromTitle (Connecteam Title → ops CrewRole)", () => {
  it("classifies drivers", () => {
    expect(roleFromTitle("Driver")).toBe("driver");
    expect(roleFromTitle("Delivery Driver")).toBe("driver");
  });

  it("classifies warehouse / asset / prep / loader titles as prep (not the office fallthrough)", () => {
    expect(roleFromTitle("Warehouse Associate")).toBe("prep");
    expect(roleFromTitle("Event Asset Processor")).toBe("prep");
    expect(roleFromTitle("Asset Prep")).toBe("prep");
    expect(roleFromTitle("Prep")).toBe("prep"); // was "other" before the fix — a literal prep title
    expect(roleFromTitle("Prep Team")).toBe("prep");
    expect(roleFromTitle("Loader")).toBe("prep");
  });

  it("safe default: an unrecognized / office title is 'other' (non-crew, never auto-routed)", () => {
    expect(roleFromTitle("Operations Coordinator")).toBe("other");
    expect(roleFromTitle("Executive Assistant")).toBe("other");
    expect(roleFromTitle("")).toBe("other");
    expect(roleFromTitle(undefined)).toBe("other");
  });

  it("coarse 'prep' role STILL includes warehouse AND asset workers (loading-coverage bucket unchanged)", () => {
    // Both load trucks at the warehouse, so both must stay role "prep" for the prep-window staffing fix.
    expect(roleFromTitle("Warehouse Associate")).toBe("prep");
    expect(roleFromTitle("Event Asset Processor")).toBe("prep");
  });
});

describe("routeEligibleFromTitle (title-derived AUTO-route eligibility)", () => {
  it("driver OR warehouse is route-eligible (warehouse helps deliver on the ground)", () => {
    expect(routeEligibleFromTitle("Driver")).toBe(true);
    expect(routeEligibleFromTitle("Delivery Driver")).toBe(true);
    expect(routeEligibleFromTitle("Warehouse Associate")).toBe(true);
    expect(routeEligibleFromTitle("Warehouse Asset Handler")).toBe(true); // warehouse precedes asset
  });

  it("asset-prep / office / untitled are NOT route-eligible", () => {
    expect(routeEligibleFromTitle("Event Asset Processor")).toBe(false); // back of warehouse
    expect(routeEligibleFromTitle("Prep")).toBe(false);
    expect(routeEligibleFromTitle("Co-Founder")).toBe(false);
    expect(routeEligibleFromTitle("Executive Assistant")).toBe(false);
    expect(routeEligibleFromTitle("")).toBe(false);
    expect(routeEligibleFromTitle(undefined)).toBe(false);
  });

  it("role and route-eligibility are independent for a warehouse worker (prep role, yet route-eligible)", () => {
    expect(roleFromTitle("Warehouse Associate")).toBe("prep");
    expect(routeEligibleFromTitle("Warehouse Associate")).toBe(true);
    // asset-prep: same prep role, but NOT route-eligible
    expect(roleFromTitle("Event Asset Processor")).toBe("prep");
    expect(routeEligibleFromTitle("Event Asset Processor")).toBe(false);
  });
});
