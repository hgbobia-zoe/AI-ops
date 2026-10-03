import { describe, it, expect } from "vitest";
import { instaworkRowStatus } from "./connections";
import type { ImportRow } from "@/lib/pull/state";

function row(p: Partial<ImportRow> & { ok: boolean }): ImportRow {
  return {
    id: p.id ?? "IL-1",
    ts: p.ts ?? "2026-10-02T12:00:00.000Z",
    source: "instawork",
    ok: p.ok,
    rowsIn: null,
    rowsWritten: null,
    rowsSkipped: null,
    detail: p.detail ?? null,
  };
}

const NOW = Date.parse("2026-10-02T12:00:00.000Z");

describe("instaworkRowStatus (browser-pull freshness)", () => {
  it("never pulled → OFF, prompts logging into Instawork in the office browser", () => {
    const r = instaworkRowStatus(null, NOW);
    expect(r.status).toBe("off");
    expect(r.headline).toBe("Not connected");
    expect(r.detail).toContain("office browser");
    expect(r.lastAt).toBeNull();
    expect(r.fixHref).toBe("/admin");
    expect(r.fixLabel).toBe("How to connect");
  });

  it("a fresh successful import → OK (Connected)", () => {
    const r = instaworkRowStatus(row({ ok: true, ts: "2026-10-02T11:30:00.000Z" }), NOW); // 30 min old
    expect(r.status).toBe("ok");
    expect(r.headline).toBe("Connected");
    expect(r.lastAt).toBe("2026-10-02T11:30:00.000Z");
    expect(r.fixHref).toBeNull();
  });

  it("a stale import (older than 120 min) → ATTENTION, says re-open Instawork", () => {
    const r = instaworkRowStatus(row({ ok: true, ts: "2026-10-02T09:00:00.000Z" }), NOW); // 3h old
    expect(r.status).toBe("attention");
    expect(r.headline).toBe("Session stale / signed out");
    expect(r.detail).toContain("re-open Instawork");
    expect(r.detail).toContain("3h ago");
    expect(r.fixHref).toBe("/admin");
    expect(r.fixLabel).toBe("Re-connect");
  });

  it("a recent import that FAILED → ATTENTION (never a fake OK)", () => {
    const r = instaworkRowStatus(row({ ok: false, ts: "2026-10-02T11:50:00.000Z" }), NOW); // 10 min old
    expect(r.status).toBe("attention");
    expect(r.headline).toBe("Session stale / signed out");
    expect(r.lastAt).toBe("2026-10-02T11:50:00.000Z");
  });

  it("exactly at the 120-min boundary is still OK; just past it is stale", () => {
    expect(instaworkRowStatus(row({ ok: true, ts: "2026-10-02T10:00:00.000Z" }), NOW).status).toBe("ok"); // 120 min
    expect(instaworkRowStatus(row({ ok: true, ts: "2026-10-02T09:59:00.000Z" }), NOW).status).toBe("attention"); // 121 min
  });

  it("minutes-ago phrasing under an hour", () => {
    const r = instaworkRowStatus(row({ ok: false, ts: "2026-10-02T11:30:00.000Z" }), NOW);
    expect(r.detail).toContain("30 min ago");
  });
});
