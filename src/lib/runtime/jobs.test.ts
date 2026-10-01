import { describe, it, expect } from "vitest";
import { computeJobStatus, RUNTIME_STALE_HOURS, type RuntimeJob } from "./jobs";
import type { ImportRow } from "@/lib/pull/state";

function row(source: string, ok: boolean, ageHours: number): ImportRow {
  return {
    id: `IL-${source}`,
    ts: new Date(Date.now() - ageHours * 3_600_000).toISOString(),
    source,
    ok,
    rowsIn: null,
    rowsWritten: null,
    rowsSkipped: null,
    detail: ok ? "done" : "failed",
  };
}

const server = (key: string, configured: boolean): RuntimeJob => ({
  key,
  label: key,
  bucket: "server",
  configured: () => configured,
  run: async () => ({ ok: true, detail: "" }),
});
const browser = (key: string): RuntimeJob => ({ key, label: key, bucket: "browser", configured: () => true });

describe("computeJobStatus", () => {
  it("a configured server job with a fresh successful run is OK", () => {
    const jobs = [server("instawork", true)];
    const s = computeJobStatus({ instawork: row("instawork", true, 1) }, Date.now(), jobs);
    expect(s[0].state).toBe("ok");
  });

  it("goes stale after the threshold", () => {
    const jobs = [server("instawork", true)];
    const s = computeJobStatus({ instawork: row("instawork", true, RUNTIME_STALE_HOURS + 1) }, Date.now(), jobs);
    expect(s[0].state).toBe("stale");
  });

  it("a failed last run is error", () => {
    const jobs = [server("x", true)];
    expect(computeJobStatus({ x: row("x", false, 1) }, Date.now(), jobs)[0].state).toBe("error");
  });

  it("configured but never run is 'never'", () => {
    const jobs = [server("x", true)];
    expect(computeJobStatus({}, Date.now(), jobs)[0].state).toBe("never");
  });

  it("an unconfigured server job is not_configured (ledger ignored)", () => {
    const jobs = [server("x", false)];
    expect(computeJobStatus({ x: row("x", true, 1) }, Date.now(), jobs)[0].state).toBe("not_configured");
  });

  it("a browser job is always browser_pending (never run server-side)", () => {
    const jobs = [browser("route")];
    // Even with a fresh successful ledger row, the runtime can't run it server-side yet.
    expect(computeJobStatus({ route: row("route", true, 1) }, Date.now(), jobs)[0].state).toBe("browser_pending");
  });
});
