import { describe, it, expect } from "vitest";
import { opsCycleConfig, saveOpsCycleConfig } from "./config";
import { DEFAULT_OPS_CYCLE } from "./periods";

// DATABASE_PATH is ":memory:" (vitest.config.ts) → a throwaway settings KV. No env overrides set here, so
// opsCycleConfig() reads the stored row first, falling back to the hard default (Thu/6).
describe("opsCycleConfig — settings-KV round-trip (the ops-cycle admin editor)", () => {
  it("defaults to Thu/6 when nothing is stored", () => {
    expect(opsCycleConfig()).toEqual(DEFAULT_OPS_CYCLE); // { anchorDow: 4, lengthDays: 6 }
  });

  it("persists and reads back a saved anchor + length", () => {
    saveOpsCycleConfig({ anchorDow: 1, lengthDays: 7 }); // Monday, 7 days
    expect(opsCycleConfig()).toEqual({ anchorDow: 1, lengthDays: 7 });
  });

  it("clamps out-of-range values on save (never breaks period math)", () => {
    saveOpsCycleConfig({ anchorDow: 9, lengthDays: 99 }); // 9 % 7 = 2 (Tue); length capped at 14
    expect(opsCycleConfig()).toEqual({ anchorDow: 2, lengthDays: 14 });
    saveOpsCycleConfig({ anchorDow: -1, lengthDays: 0 }); // -1 → 6 (Sat); length floored at 1
    expect(opsCycleConfig()).toEqual({ anchorDow: 6, lengthDays: 1 });
  });
});
