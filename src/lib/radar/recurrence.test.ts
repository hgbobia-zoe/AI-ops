import { describe, it, expect } from "vitest";
import { deriveRecurrence, type SeriesInstance } from "./recurrence";

const inst = (id: string, date: string | null): SeriesInstance => ({ id, name: id, date, isSeed: true });
const series = { id: "SER-x", name: "X Conference", cadence: "ANNUAL" as const };
const TODAY = "2026-09-17";

describe("deriveRecurrence", () => {
  it("returns NONE when there is no series or no history", () => {
    expect(deriveRecurrence(null, [], TODAY).confidence).toBe("NONE");
    expect(deriveRecurrence(series, [], TODAY).confidence).toBe("NONE");
  });

  it("is HIGH confidence with 3+ consistent annual years", () => {
    const r = deriveRecurrence(series, [inst("a", "2024-09-14"), inst("b", "2025-09-13"), inst("c", "2026-09-12")], TODAY);
    expect(r.confidence).toBe("HIGH");
    expect(r.recurring).toBe(true);
  });

  it("predicts an UNANNOUNCED next when the latest instance is in the past and none is announced", () => {
    const r = deriveRecurrence(series, [inst("a", "2024-08-22"), inst("b", "2025-08-21"), inst("c", "2026-08-20")], TODAY);
    expect(r.predictedNext).not.toBeNull();
    expect(r.predictedNext!.year).toBe(2027);
    expect(r.predictedNext!.basis).toMatch(/not yet announced/i);
  });

  it("does NOT predict when a future instance is already announced", () => {
    const r = deriveRecurrence(series, [inst("a", "2025-09-13"), inst("b", "2026-09-12"), inst("c", "2027-09-17")], TODAY);
    // the 2027 instance is real → point at it, don't fabricate a projection
    expect(r.predictedNext).toBeNull();
  });

  it("is MEDIUM confidence with exactly two years", () => {
    const r = deriveRecurrence(series, [inst("a", "2025-09-13"), inst("b", "2026-09-12")], TODAY);
    expect(r.confidence).toBe("MEDIUM");
  });
});
