import { describe, it, expect } from "vitest";
import { roleFromTitle } from "./connecteam";

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
});
