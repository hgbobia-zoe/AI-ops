import { describe, it, expect } from "vitest";
import { buildAssignmentNotice, roleLabelForWorker, maskPhone } from "./assignNotify";

// No dashes (hyphen, en dash, em dash) and no emoji — the house comms rule.
const DASH = /[-‐-―]/;
// Common emoji ranges (pictographs, symbols, dingbats). Plain text + punctuation must pass.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u;

describe("buildAssignmentNotice", () => {
  it("builds an assigned notice with every field, no dashes, no emoji", () => {
    const msg = buildAssignmentNotice({
      kind: "assigned",
      firstName: "Marcus",
      roleLabel: "driver",
      dateHuman: "Wed, Oct 8",
      routeLabel: "Truck 2",
      windowText: "7:00 AM to 3:00 PM",
    });
    expect(msg).toContain("Hi Marcus");
    expect(msg).toContain("driver");
    expect(msg).toContain("Wed, Oct 8");
    expect(msg).toContain("Truck 2");
    expect(msg).toContain("7:00 AM to 3:00 PM");
    expect(msg).not.toMatch(DASH);
    expect(msg).not.toMatch(EMOJI);
  });

  it("builds a removed notice, no dashes, no emoji", () => {
    const msg = buildAssignmentNotice({
      kind: "removed",
      firstName: "Ivy",
      roleLabel: "field crew",
      dateHuman: "Fri, Oct 10",
      routeLabel: "Truck 1",
    });
    expect(msg).toContain("no longer scheduled");
    expect(msg).toContain("Ivy");
    expect(msg).toContain("field crew");
    expect(msg).toContain("(Truck 1)");
    expect(msg).not.toMatch(DASH);
    expect(msg).not.toMatch(EMOJI);
  });

  it("omits unknown optional fields instead of fabricating them", () => {
    const msg = buildAssignmentNotice({
      kind: "assigned",
      firstName: "Sam",
      roleLabel: "warehouse prep",
      dateHuman: "Mon, Oct 6",
      routeLabel: null,
      windowText: null,
    });
    expect(msg).toBe("Hi Sam, you're on the Zoe Events schedule for warehouse prep on Mon, Oct 6. Reply here with any questions.");
    expect(msg).not.toContain("(");
    expect(msg).not.toContain("null");
  });

  it("falls back to a neutral greeting when the first name is unknown (never a fake name)", () => {
    const msg = buildAssignmentNotice({ kind: "assigned", firstName: "", roleLabel: "driver", dateHuman: "Tue, Oct 7" });
    expect(msg).toContain("Hi there,");
    expect(msg).not.toMatch(DASH);
  });
});

describe("roleLabelForWorker", () => {
  it("maps each role to a worker-friendly word", () => {
    expect(roleLabelForWorker("driver")).toBe("driver");
    expect(roleLabelForWorker("field")).toBe("field crew");
    expect(roleLabelForWorker("prep")).toBe("warehouse prep");
  });
});

describe("maskPhone", () => {
  it("keeps only the last four digits, never the full number", () => {
    const masked = maskPhone("+1 (301) 640-0251");
    expect(masked).toContain("0251");
    expect(masked).not.toContain("640");
    expect(masked).not.toContain("301");
  });
  it("returns empty for no phone", () => {
    expect(maskPhone("")).toBe("");
    expect(maskPhone(null)).toBe("");
  });
});
