import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShiftException } from "./exceptions";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "aiops-exc-"));
  process.env.DATABASE_PATH = join(dir, "test.db");
});
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

async function store() {
  return import("./exceptionStore");
}

function finding(shiftId: string, code: ShiftException["code"], date: string, severity: ShiftException["severity"] = "YELLOW") {
  return { signature: `${shiftId}:${code}`, shiftId, routeId: null, code, severity, title: code, detail: "d", fixLabel: "fix", rank: severity === "RED" ? 0 : 1, date };
}

describe("reconcileShiftExceptions", () => {
  const DATE = "2026-10-20";

  it("opens new, then resolves a vanished finding, then regresses a returning one", async () => {
    const { reconcileShiftExceptions, getActiveShiftExceptions } = await store();

    const c1 = reconcileShiftExceptions([finding("SH-x", "no_truck", DATE, "RED"), finding("SH-x", "no_window", DATE)], [DATE]);
    expect(c1.opened).toHaveLength(2);
    expect(c1.activeCount).toBe(2);

    // no_window gone on the next scan → resolved; no_truck persists (updated in place, not duplicated).
    const c2 = reconcileShiftExceptions([finding("SH-x", "no_truck", DATE, "RED")], [DATE]);
    expect(c2.resolved.map((r) => r.code)).toEqual(["no_window"]);
    expect(getActiveShiftExceptions()).toHaveLength(1);

    // no_window returns → regressed (reopened), not a second row.
    const c3 = reconcileShiftExceptions([finding("SH-x", "no_truck", DATE, "RED"), finding("SH-x", "no_window", DATE)], [DATE]);
    expect(c3.regressed.map((r) => r.code)).toEqual(["no_window"]);
    expect(getActiveShiftExceptions()).toHaveLength(2);
  });

  it("freezes (does not resolve) a staffing-derived exception on an unverified date", async () => {
    const { reconcileShiftExceptions, getActiveShiftExceptions } = await store();
    const D = "2026-10-21";
    reconcileShiftExceptions([finding("SH-y", "understaffed", D, "RED")], [D]);
    const before = getActiveShiftExceptions().filter((e) => e.shiftId === "SH-y").length;
    expect(before).toBe(1);

    // Connecteam unreachable for D → understaffed absent from findings must NOT resolve (frozen).
    reconcileShiftExceptions([], [D], new Date(), new Set([D]));
    expect(getActiveShiftExceptions().some((e) => e.shiftId === "SH-y" && e.code === "understaffed")).toBe(true);
  });
});
