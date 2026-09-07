import { describe, it, expect } from "vitest";
import { initialsOf, shortDate, salesOsNoteLine } from "./noteFormat";
import { decideCallNote } from "./callNote";

describe("noteFormat", () => {
  it("derives two-letter initials from a name", () => {
    expect(initialsOf("Hermann Gbobia")).toBe("HG");
    expect(initialsOf("cynthia")).toBe("C");
    expect(initialsOf("  ")).toBeNull();
    expect(initialsOf(null)).toBeNull();
  });

  it("formats the date as M/D with no leading zeros", () => {
    expect(shortDate("2026-09-07")).toBe("9/7");
    expect(shortDate("2026-11-20")).toBe("11/20");
  });

  it("tags known vs unknown actor in the team's pattern", () => {
    expect(salesOsNoteLine("HG", 'Sent text: "hi"', "2026-09-07")).toBe('HG(by SalesOS) - 9/7 - Sent text: "hi"');
    expect(salesOsNoteLine(null, "Got voicemail", "2026-09-07")).toBe("SalesOS - 9/7 - Got voicemail");
  });
});

describe("callNote — decideCallNote", () => {
  it("logs the summary for a real conversation", () => {
    expect(decideCallNote({ eventType: "call.summary.completed", direction: "incoming", durationSec: 240, summary: "Customer confirmed delivery time." }))
      .toBe("Call: Customer confirmed delivery time.");
  });

  it("notes a voicemail (no summary) by direction, only on the completed event", () => {
    expect(decideCallNote({ eventType: "call.completed", direction: "incoming", durationSec: 0, summary: null })).toBe("Got voicemail");
    expect(decideCallNote({ eventType: "call.completed", direction: "outgoing", durationSec: 0, summary: null })).toBe("Left voicemail");
  });

  it("logs nothing for an answered call that has no summary yet", () => {
    expect(decideCallNote({ eventType: "call.completed", direction: "incoming", durationSec: 180, summary: null })).toBeNull();
  });

  it("logs nothing for non-call events", () => {
    expect(decideCallNote({ eventType: "call.recording.completed", direction: "incoming", durationSec: 0, summary: null })).toBeNull();
  });
});
