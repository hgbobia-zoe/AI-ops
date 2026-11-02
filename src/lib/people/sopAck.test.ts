import { describe, it, expect } from "vitest";
import { sameName } from "./sopAck";
import { sopFor } from "./sop";

describe("SOP sign off", () => {
  it("accepts the hire's own name regardless of case, accents or spacing", () => {
    expect(sameName("jose  garcia", "José García")).toBe(true);
    expect(sameName("Someone Else", "José García")).toBe(false);
    expect(sameName("", "")).toBe(false);
  });
  it("Sales Associate has a versioned SOP with no placeholders", () => {
    const sop = sopFor("sales_associate")!;
    expect(sop.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(JSON.stringify(sop)).not.toMatch(/\[Company Name\]/);
    expect(sopFor("warehouse")).toBeNull();
  });
});
