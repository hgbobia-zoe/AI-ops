import { describe, expect, it } from "vitest";
import { deriveSignals, openFromSignal, type ImprovementSignal } from "./signals";

describe("deriveSignals (pure)", () => {
  it("maps a recurring SHIFT_PUBLISH failure to an auto-openable scheduling run", () => {
    const [s] = deriveSignals([{ action: "SHIFT_PUBLISH_CONNECTEAM_FAILED", count: 3, lastAt: "2026-10-12T00:00:00Z" }], []);
    expect(s.source).toBe("audit_failure");
    expect(s.blade).toBe("scheduling");
    expect(s.changeKey).toBe("signal:audit:SHIFT_PUBLISH_CONNECTEAM_FAILED");
    expect(s.allowedPaths).toContain("src/lib/connecteam.ts");
    expect(s.autoOpenable).toBe(true);
    expect(s.severity).toBe("medium"); // 3 occurrences
  });

  it("does NOT auto-open a one-off failure (below the recurrence bar)", () => {
    const [s] = deriveSignals([{ action: "SHIFT_PUBLISH_NO_SCHEDULER", count: 1, lastAt: null }], []);
    expect(s.autoOpenable).toBe(false);
    expect(s.severity).toBe("low");
  });

  it("surfaces an UNMAPPED failure as needs-human (not auto-openable, no scope)", () => {
    const [s] = deriveSignals([{ action: "GITHUB_PR_MERGE_FAILED", count: 9, lastAt: null }], []);
    expect(s.blade).toBe("unknown");
    expect(s.allowedPaths).toEqual([]);
    expect(s.autoOpenable).toBe(false); // its fix would touch forbidden paths — a human must scope it
    expect(s.severity).toBe("high"); // still surfaced, and ranked by severity
  });

  it("maps a failed runtime job to an auto-openable run (fails open at 1)", () => {
    const [s] = deriveSignals([], [{ key: "connecteam", detail: "unreachable", lastAt: null }]);
    expect(s.source).toBe("runtime_job");
    expect(s.changeKey).toBe("signal:job:connecteam");
    expect(s.allowedPaths).toEqual(["src/lib/connecteam.ts"]);
    expect(s.autoOpenable).toBe(true);
  });

  it("surfaces an unknown failed job but does not auto-open it", () => {
    const [s] = deriveSignals([], [{ key: "mystery-job", detail: null, lastAt: null }]);
    expect(s.blade).toBe("back-office");
    expect(s.autoOpenable).toBe(false);
  });

  it("orders most-actionable first (severity then count)", () => {
    const out = deriveSignals(
      [
        { action: "SHIFT_PUBLISH_NO_SCHEDULER", count: 1, lastAt: null }, // low
        { action: "GITHUB_PR_MERGE_FAILED", count: 6, lastAt: null }, //    high
        { action: "SHIFT_PUBLISH_CONNECTEAM_FAILED", count: 2, lastAt: null }, // medium
      ],
      [],
    );
    expect(out.map((s) => s.severity)).toEqual(["high", "medium", "low"]);
  });
});

describe("openFromSignal (deterministic guards)", () => {
  const base: ImprovementSignal = {
    source: "audit_failure",
    changeKey: "signal:audit:TEST",
    blade: "scheduling",
    summary: "s",
    problem: "p",
    allowedPaths: ["src/lib/connecteam.ts"],
    count: 2,
    lastAt: null,
    severity: "medium",
    autoOpenable: true,
  };

  it("skips a signal that is not auto-openable (needs human scoping)", () => {
    const r = openFromSignal({ ...base, autoOpenable: false });
    expect(r.opened).toBeUndefined();
    expect(r.skipped).toMatch(/not auto-openable/);
  });

  it("refuses to open a run whose scope touches an always-forbidden path (defense in depth)", () => {
    // Even if something marked it auto-openable, the forbidden-path check is the final net.
    const r = openFromSignal({ ...base, allowedPaths: ["src/lib/auth/roles.ts"] });
    expect(r.opened).toBeUndefined();
    expect(r.skipped).toMatch(/forbidden/);
  });
});
