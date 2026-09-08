import { describe, it, expect } from "vitest";
import { analyzeLostDeal } from "./autopsy";

describe("autopsy — analyzeLostDeal", () => {
  it("flags a quote that never went out", () => {
    const a = analyzeLostDeal({ everSent: false, quoteSentDate: null, eventDate: "2026-06-01", lossReason: null, internalNotes: null });
    expect(a.breakpoints[0].area).toBe("Quote never sent");
  });

  it("flags no follow-up when the log is sparse", () => {
    const a = analyzeLostDeal({ everSent: true, quoteSentDate: "2026-05-01", eventDate: "2026-06-01", lossReason: null, internalNotes: "5/1 - sent the quote" });
    expect(a.breakpoints.some((b) => b.area === "No follow-up")).toBe(true);
  });

  it("flags going dark after many unanswered attempts", () => {
    const notes = ["5/1 sent quote", "5/2 call no answer left vm", "5/4 call no answer vm", "5/6 call no answer vm", "5/8 text no response", "5/10 call no answer vm"].join("\n");
    const a = analyzeLostDeal({ everSent: true, quoteSentDate: "2026-05-01", eventDate: "2026-08-01", lossReason: null, internalNotes: notes });
    expect(a.comms.attempts).toBeGreaterThanOrEqual(5);
    expect(a.breakpoints.some((b) => b.area === "Went dark")).toBe(true);
  });

  it("flags a quote sent too close to the event", () => {
    const a = analyzeLostDeal({ everSent: true, quoteSentDate: "2026-05-30", eventDate: "2026-06-01", lossReason: null, internalNotes: "5/30 sent quote\n5/31 follow up" });
    expect(a.quoteLeadDays).toBe(2);
    expect(a.breakpoints.some((b) => b.area === "Quoted late")).toBe(true);
  });

  it("says Unknown when nothing in the data points to a process failure, and keeps the recorded reason", () => {
    const notes = ["5/1 sent quote", "5/3 call - spoke, will decide", "5/6 follow up call"].join("\n");
    const a = analyzeLostDeal({ everSent: true, quoteSentDate: "2026-05-01", eventDate: "2026-08-01", lossReason: "Went with a competitor", internalNotes: notes });
    expect(a.breakpoints.some((b) => b.area === "Unknown")).toBe(true);
    expect(a.recordedReason).toBe("Went with a competitor");
  });
});
