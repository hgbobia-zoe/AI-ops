import { describe, expect, it } from "vitest";
import { presentEta } from "./etaView";

describe("presentEta — real-primary, labeled fallback, never fabricated", () => {
  it("shows the live treatment only with a real fix while en route", () => {
    expect(presentEta({ enRoute: true, hasLiveFix: true, hasPlannedEta: true })).toEqual({ mode: "live" });
    // a live fix but not en route does NOT claim live
    expect(presentEta({ enRoute: false, hasLiveFix: true, hasPlannedEta: true })).toEqual({
      mode: "scheduled",
      liveUnavailable: false,
    });
  });

  it("falls back to the planned ETA and flags it when en route but live is unavailable", () => {
    expect(presentEta({ enRoute: true, hasLiveFix: false, hasPlannedEta: true })).toEqual({
      mode: "scheduled",
      liveUnavailable: true,
    });
  });

  it("labels a not-yet-en-route planned ETA as a plain scheduled estimate", () => {
    expect(presentEta({ enRoute: false, hasLiveFix: false, hasPlannedEta: true })).toEqual({
      mode: "scheduled",
      liveUnavailable: false,
    });
  });

  it("shows nothing when completed or when there is no ETA at all", () => {
    expect(presentEta({ enRoute: false, hasLiveFix: false, hasPlannedEta: true, completed: true })).toEqual({
      mode: "none",
    });
    expect(presentEta({ enRoute: true, hasLiveFix: false, hasPlannedEta: false })).toEqual({ mode: "none" });
  });
});
