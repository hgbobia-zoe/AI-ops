import { describe, expect, it } from "vitest";
import { checkBudget, retriesExhausted, resolveBudget, DEFAULT_BUDGET } from "./budget";
import { checkScope, pathInScope, isAlwaysForbidden, normalizePath } from "./scope";
import { ZERO_METRICS, type RunScope } from "./types";

describe("change budget", () => {
  it("passes when under all limits and names every breach when over", () => {
    expect(checkBudget(ZERO_METRICS, DEFAULT_BUDGET).ok).toBe(true);
    const over = checkBudget({ files: 99, lines: 9999, dirs: 99, commands: 9999, retries: 9, elapsedMin: 999 }, DEFAULT_BUDGET);
    expect(over.ok).toBe(false);
    expect(over.exceeded.length).toBe(6);
  });

  it("flags retry exhaustion at the limit", () => {
    expect(retriesExhausted({ ...ZERO_METRICS, retries: 2 }, DEFAULT_BUDGET)).toBe(false);
    expect(retriesExhausted({ ...ZERO_METRICS, retries: 3 }, DEFAULT_BUDGET)).toBe(true);
  });

  it("resolveBudget ignores non-positive/NaN overrides", () => {
    const b = resolveBudget({ maxFiles: 5, maxLines: 0, maxDirs: -1, maxCommands: NaN });
    expect(b.maxFiles).toBe(5); // applied
    expect(b.maxLines).toBe(DEFAULT_BUDGET.maxLines); // 0 ignored
    expect(b.maxDirs).toBe(DEFAULT_BUDGET.maxDirs); // negative ignored
    expect(b.maxCommands).toBe(DEFAULT_BUDGET.maxCommands); // NaN ignored
    expect(resolveBudget(null)).toEqual(DEFAULT_BUDGET);
  });
});

describe("scope gate", () => {
  const scope: RunScope = {
    blade: "scheduling",
    summary: "capture route changes",
    problem: "route changes after schedules aren't caught",
    allowedPaths: ["src/lib/scheduling/", "src/components/scheduling/", "src/app/(console)/scheduling/"],
    forbiddenPaths: ["src/lib/scheduling/legacy/"],
  };

  it("normalizes paths", () => {
    expect(normalizePath("./src\\lib\\x.ts")).toBe("src/lib/x.ts");
    expect(normalizePath("/src/lib/x.ts")).toBe("src/lib/x.ts");
  });

  it("allows in-scope paths and rejects out-of-scope ones", () => {
    expect(pathInScope("src/lib/scheduling/optimize.ts", scope)).toBe(true);
    expect(pathInScope("src/components/scheduling/Board.tsx", scope)).toBe(true);
    expect(pathInScope("src/lib/finance/cost.ts", scope)).toBe(false); // out of scope
    expect(pathInScope("src/lib/scheduling/legacy/old.ts", scope)).toBe(false); // explicitly forbidden
  });

  it("ALWAYS forbids the agent's own safety controls, whatever the scope says", () => {
    // Even if a request tried to put these in allowedPaths, they stay forbidden.
    const sneaky: RunScope = { ...scope, allowedPaths: [...scope.allowedPaths, ".github/", "src/lib/auth/", "src/lib/ai/improvement/"] };
    expect(isAlwaysForbidden(".github/workflows/ci.yml")).toBe(true);
    expect(pathInScope(".github/workflows/ci.yml", sneaky)).toBe(false);
    expect(pathInScope("src/lib/auth/roles.ts", sneaky)).toBe(false);
    expect(pathInScope("src/lib/aiorg/approvals.ts", sneaky)).toBe(false);
    expect(pathInScope("src/lib/ai/improvement/machine.ts", sneaky)).toBe(false);
    expect(pathInScope("vitest.config.ts", sneaky)).toBe(false);
  });

  it("checkScope classifies every violation", () => {
    const res = checkScope(
      ["src/lib/scheduling/ok.ts", "src/lib/finance/x.ts", ".github/workflows/ci.yml", "src/lib/scheduling/legacy/o.ts"],
      scope,
    );
    expect(res.ok).toBe(false);
    expect(res.violations).toEqual([
      { path: "src/lib/finance/x.ts", reason: "out_of_scope" },
      { path: ".github/workflows/ci.yml", reason: "always_forbidden" },
      { path: "src/lib/scheduling/legacy/o.ts", reason: "forbidden" },
    ]);
  });
});
