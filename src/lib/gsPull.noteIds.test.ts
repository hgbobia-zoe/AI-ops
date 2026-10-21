import { describe, it, expect } from "vitest";
import { selectNoteCaptureIds, buildOfficePullScript, NOTE_CAPTURE_CAP, type PullProjectLite } from "./gsPull";

// Part A: note/comms capture must now reach SIGNED near-term deliveries (so the pre-shift debrief can read
// the customer-attention notes) WITHOUT dropping the existing open-lead capture. This tests the pure
// id-selection the bookmarklet + extension mirror inline.

const TODAY = "2026-10-21";
const HORIZON = "2026-10-24"; // TODAY + 3 days
// Logistics dates use a midday-UTC instant so pullYmd's local-day normalization lands on the intended
// calendar day in both the ET dev box and the UTC CI runner (a date-only string can shift a day under an
// offset). This mirrors how real Goodshuffle timestamps carry a time.
const AT = (ymd: string) => `${ymd}T12:00:00Z`;

describe("selectNoteCaptureIds", () => {
  it("includes a signed near-term delivery AND still includes open leads, deduped", () => {
    const projects: Record<string, PullProjectLite> = {
      OPEN1: { signed: false, statusLabel: "Quote Sent", logistics_start_date: AT("2026-11-01") }, // future open lead
      OPEN_UNDATED: { signed: false, statusLabel: "New", logistics_start_date: null }, // undated open lead
      SIGNED_SOON: { signed: true, statusLabel: "Contract Signed", logistics_start_date: AT("2026-10-22") }, // delivery in 1 day
      SIGNED_TODAY: { signed: true, statusLabel: "Contract Signed", logistics_start_date: AT("2026-10-21") }, // delivery today
    };
    const ids = selectNoteCaptureIds(projects, TODAY, HORIZON);
    expect(ids).toContain("OPEN1");
    expect(ids).toContain("OPEN_UNDATED");
    expect(ids).toContain("SIGNED_SOON");
    expect(ids).toContain("SIGNED_TODAY");
    // Deduped: each id once.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("excludes signed deliveries beyond the horizon and past deliveries", () => {
    const projects: Record<string, PullProjectLite> = {
      SIGNED_FAR: { signed: true, statusLabel: "Contract Signed", logistics_start_date: AT("2026-12-01") }, // too far out
      SIGNED_PAST: { signed: true, statusLabel: "Contract Signed", logistics_start_date: AT("2026-10-10") }, // already delivered
      SIGNED_UNDATED: { signed: true, statusLabel: "Contract Signed", logistics_start_date: null }, // no date → not a delivery
    };
    expect(selectNoteCaptureIds(projects, TODAY, HORIZON)).toEqual([]);
  });

  it("still excludes lost / cancelled / dead open leads and past-dated open leads", () => {
    const projects: Record<string, PullProjectLite> = {
      LOST: { signed: false, statusLabel: "Lost", logistics_start_date: AT("2026-11-01") },
      CANCELLED: { signed: false, statusLabel: "Cancelled", logistics_start_date: AT("2026-11-01") },
      DEAD: { signed: false, statusLabel: "Dead Lead", logistics_start_date: AT("2026-11-01") },
      PAST_OPEN: { signed: false, statusLabel: "Quote Sent", logistics_start_date: AT("2026-01-01") },
    };
    expect(selectNoteCaptureIds(projects, TODAY, HORIZON)).toEqual([]);
  });

  it("caps the combined set (open leads first, then signed deliveries)", () => {
    const projects: Record<string, PullProjectLite> = {};
    for (let i = 0; i < NOTE_CAPTURE_CAP + 50; i++) projects[`O${i}`] = { signed: false, statusLabel: "New", logistics_start_date: null };
    projects["SIGNED_SOON"] = { signed: true, statusLabel: "Contract Signed", logistics_start_date: AT("2026-10-22") };
    const ids = selectNoteCaptureIds(projects, TODAY, HORIZON);
    expect(ids).toHaveLength(NOTE_CAPTURE_CAP);
  });
});

describe("bookmarklet mirrors the widened selection inline", () => {
  const src = buildOfficePullScript("https://zoe-dispatch.fly.dev");
  it("captures over both open leads and signed near-term deliveries, capped", () => {
    expect(src).toContain("signedIds");
    expect(src).toContain("captureIds");
    expect(src).toContain("horizonY");
    expect(src).toContain(`slice(0,${NOTE_CAPTURE_CAP})`);
    // It no longer iterates the old signed-excluding openIds set directly for note capture.
    expect(src).toContain("i>=captureIds.length");
  });
});
