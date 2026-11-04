import { describe, it, expect } from "vitest";
import { collectBladeSignals } from "./service";

// DATABASE_PATH is ":memory:" (vitest.config.ts), migrated on first use.
describe("command center: live blade signal reads", () => {
  it("reads every blade from a fresh database without a failure and raises nothing", () => {
    const failed: string[] = [];
    const items = collectBladeSignals("2026-11-03", (blade, err) => failed.push(`${blade}: ${String(err)}`));
    expect(failed).toEqual([]);
    expect(items).toEqual([]);
  });
});
