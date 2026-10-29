// Overview STATE classification (spec §4) — the pure matrix behind the state-aware overview. No DB: we feed
// health + counts fixtures and assert the single honest top-level state. The key honesty invariants are
// encoded here: an unrun source is "setup_needed" (not "0 records"), an errored source is flagged before its
// counts, and zero queued records with a live source is "retrieving"/"no_records" — never "populated".

import { describe, it, expect } from "vitest";
import { seoOverviewState } from "./dashboard";
import type { SeoHealthStatus } from "./types";

function health(status: SeoHealthStatus, stale = false): { status: SeoHealthStatus; stale: boolean } {
  return { status, stale };
}

describe("seoOverviewState", () => {
  it("is setup_needed when the source has never run, even with zero records", () => {
    expect(seoOverviewState({ health: health("never"), counts: { total: 0 } })).toBe("setup_needed");
  });

  it("is setup_needed when not configured", () => {
    expect(seoOverviewState({ health: health("not_configured"), counts: { total: 0 } })).toBe("setup_needed");
  });

  it("flags error before anything else, regardless of record count", () => {
    expect(seoOverviewState({ health: health("error"), counts: { total: 0 } })).toBe("error");
    expect(seoOverviewState({ health: health("error"), counts: { total: 42 } })).toBe("error");
  });

  it("is retrieving when the source is reading (ok) but nothing is queued yet", () => {
    expect(seoOverviewState({ health: health("ok"), counts: { total: 0 } })).toBe("retrieving");
  });

  it("is no_records when the source has gone stale with nothing queued", () => {
    expect(seoOverviewState({ health: health("stale", true), counts: { total: 0 } })).toBe("no_records");
  });

  it("is populated when there are records and the source is fresh", () => {
    expect(seoOverviewState({ health: health("ok"), counts: { total: 7 } })).toBe("populated");
  });

  it("is stale when there are records but the source is behind the staleness window", () => {
    expect(seoOverviewState({ health: health("stale", true), counts: { total: 7 } })).toBe("stale");
    // Defensive: a stale flag with an otherwise-ok status still reads as stale when records exist.
    expect(seoOverviewState({ health: health("ok", true), counts: { total: 7 } })).toBe("stale");
  });

  it("never reports populated for zero records", () => {
    const states = (["never", "ok", "stale", "error", "not_configured"] as SeoHealthStatus[]).map((s) =>
      seoOverviewState({ health: health(s, s === "stale"), counts: { total: 0 } }),
    );
    expect(states).not.toContain("populated");
  });
});
