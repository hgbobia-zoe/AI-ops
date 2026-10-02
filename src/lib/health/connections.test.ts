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

describe("instaworkRowStatus", () => {
  it("no cookie → OFF (never called), with the add-cookie prompt", () => {
    const r = instaworkRowStatus(false, null);
    expect(r.status).toBe("off");
    expect(r.headline).toBe("Not connected");
    expect(r.detail).toBe("Add the Instawork session cookie to reconcile temp labor.");
    expect(r.lastAt).toBeNull();
  });

  it("no cookie → OFF even if a stale ledger row exists (config presence wins)", () => {
    const r = instaworkRowStatus(false, row({ ok: true, ts: "2026-10-01T00:00:00.000Z" }));
    expect(r.status).toBe("off");
    expect(r.lastAt).toBeNull();
  });

  it("configured + last call FAILED → ATTENTION with the failure detail + re-paste prompt", () => {
    const r = instaworkRowStatus(true, row({ ok: false, detail: "HTTP 403", ts: "2026-10-02T13:00:00.000Z" }));
    expect(r.status).toBe("attention");
    expect(r.headline).toBe("Cookie expired / unreachable");
    expect(r.detail).toContain("HTTP 403");
    expect(r.detail).toContain("Re-paste the session cookie");
    expect(r.lastAt).toBe("2026-10-02T13:00:00.000Z");
  });

  it("configured + last call failed with no detail → ATTENTION, still prompts a re-paste", () => {
    const r = instaworkRowStatus(true, row({ ok: false, detail: null }));
    expect(r.status).toBe("attention");
    expect(r.detail).toContain("Re-paste the session cookie");
  });

  it("configured + last call OK → OK (Connected)", () => {
    const r = instaworkRowStatus(true, row({ ok: true, detail: "3 shifts", ts: "2026-10-02T14:00:00.000Z" }));
    expect(r.status).toBe("ok");
    expect(r.headline).toBe("Connected");
    expect(r.lastAt).toBe("2026-10-02T14:00:00.000Z");
  });

  it("configured + no call recorded yet → OK (honest: no failure evidence, never a fake failure)", () => {
    const r = instaworkRowStatus(true, null);
    expect(r.status).toBe("ok");
    expect(r.headline).toBe("Connected");
    expect(r.lastAt).toBeNull();
  });
});
