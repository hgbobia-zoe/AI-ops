import { describe, it, expect } from "vitest";
import { roleFromTitle } from "./connecteam";

describe("roleFromTitle (Connecteam Title → ops CrewRole)", () => {
  it("classifies drivers", () => {
    expect(roleFromTitle("Driver")).toBe("driver");
    expect(roleFromTitle("Delivery Driver")).toBe("driver");
  });

  // THE TRUCK LINE (owner directive 2026-10-30): a "warehouse" title is TRUCK-ELIGIBLE field crew; an
  // asset/prep/loader title is warehouse-prep-only and NEVER rides. Two warehouse titles → two roles.
  it("classifies a Warehouse Associate as the truck-eligible 'warehouse' role", () => {
    expect(roleFromTitle("Warehouse Associate")).toBe("warehouse");
    expect(roleFromTitle("Warehouse")).toBe("warehouse");
    expect(roleFromTitle("Warehouse Crew")).toBe("warehouse");
  });

  it("classifies asset / prep / loader titles as the non-truck 'prep' role", () => {
    expect(roleFromTitle("Event Asset Processor")).toBe("prep"); // the Raquel/Mayerlin title — never on a truck
    expect(roleFromTitle("Asset Prep")).toBe("prep");
    expect(roleFromTitle("Prep")).toBe("prep");
    expect(roleFromTitle("Prep Team")).toBe("prep");
    expect(roleFromTitle("Loader")).toBe("prep");
  });

  it("safe default: an unrecognized / office title is 'other' (non-crew, never auto-routed)", () => {
    expect(roleFromTitle("Operations Coordinator")).toBe("other");
    expect(roleFromTitle("Executive Assistant")).toBe("other");
    expect(roleFromTitle("")).toBe("other");
    expect(roleFromTitle(undefined)).toBe("other");
  });

  // THE RAQUEL FIX (2026-10-30): a back-office worker must NEVER be classified as delivery crew, so the
  // auto-router (which gates purely on this role) can never place them on a truck.
  it("classifies plain back-office titles as 'other' (never auto-routed)", () => {
    expect(roleFromTitle("Office Manager")).toBe("other");
    expect(roleFromTitle("Administrative Assistant")).toBe("other");
    expect(roleFromTitle("Bookkeeper")).toBe("other");
    expect(roleFromTitle("Account Manager")).toBe("other");
    expect(roleFromTitle("Sales Associate")).toBe("other");
    expect(roleFromTitle("Marketing Coordinator")).toBe("other");
    expect(roleFromTitle("Receptionist")).toBe("other");
    expect(roleFromTitle("Finance Director")).toBe("other");
  });

  it("OFFICE WINS over an incidental crew word — a back-office title that merely contains a crew word is still 'other'", () => {
    // These were the real bug: a loose substring allow-list promoted them to delivery crew and auto-assigned them.
    expect(roleFromTitle("Warehouse Manager")).toBe("other");
    expect(roleFromTitle("Asset Manager")).toBe("other");
    expect(roleFromTitle("Driver Coordinator")).toBe("other");
    expect(roleFromTitle("Warehouse Operations Manager")).toBe("other");
    expect(roleFromTitle("Inventory / Asset Administrator")).toBe("other");
  });

  it("whole-word matching: a crew keyword embedded in an unrelated word does NOT false-match to crew", () => {
    // "driver" is not a standalone word here; without whole-word matching this would wrongly be "driver".
    expect(roleFromTitle("Screwdriver Specialist")).toBe("other");
  });
});
