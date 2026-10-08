import { describe, expect, it } from "vitest";
import { evaluateHealth, commitMatches, type HealthCheck } from "./verify";
import { rollbackDecision } from "./rollback";

describe("post-deploy health evaluation", () => {
  it("is healthy only when every CRITICAL check passes", () => {
    const pass: HealthCheck[] = [
      { name: "version", critical: true, ok: true, detail: "" },
      { name: "runtime", critical: true, ok: true, detail: "" },
      { name: "integrations", critical: false, ok: false, detail: "instawork stale" }, // non-critical fail
    ];
    const r = evaluateHealth(pass);
    expect(r.healthy).toBe(true); // non-critical failure doesn't fail the deploy
    expect(r.failures).toHaveLength(0);

    const fail = evaluateHealth([
      { name: "version", critical: true, ok: false, detail: "wrong commit" },
      { name: "runtime", critical: true, ok: true, detail: "" },
    ]);
    expect(fail.healthy).toBe(false);
    expect(fail.failures[0]).toContain("version");
  });

  it("commitMatches is lenient on unknown/empty and strict otherwise", () => {
    expect(commitMatches("abc123def", "abc123")).toBe(true); // short prefix
    expect(commitMatches("abc123", "abc123def")).toBe(true); // other direction
    expect(commitMatches("abc123", "zzz999")).toBe(false);
    expect(commitMatches("unknown", "abc")).toBe(true); // can't verify -> don't block here (version check marks non-critical)
    expect(commitMatches("abc", null)).toBe(true);
    expect(commitMatches("", "")).toBe(true);
  });
});

describe("rollback decision", () => {
  const healthy = { healthy: true, checkedAt: "", detail: "", failures: [] };
  const unhealthy = { healthy: false, checkedAt: "", detail: "", failures: ["runtime: boom"] };

  it("does nothing when healthy", () => {
    expect(rollbackDecision(healthy, { autoRollback: true }).action).toBe("none");
    expect(rollbackDecision(healthy, { autoRollback: false }).action).toBe("none");
  });

  it("auto-rolls-back only when enabled, else escalates to a human", () => {
    expect(rollbackDecision(unhealthy, { autoRollback: true }).action).toBe("rollback");
    const esc = rollbackDecision(unhealthy, { autoRollback: false });
    expect(esc.action).toBe("human_review");
    if (esc.action === "human_review") expect(esc.reason).toContain("unhealthy");
  });
});
