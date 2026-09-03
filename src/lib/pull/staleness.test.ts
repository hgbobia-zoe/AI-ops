import { describe, it, expect } from "vitest";
import { recordPull, logImport, getRecentImports } from "./state";
import { checkPullStaleness } from "./staleness";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

describe("per-source staleness", () => {
  it("fresh routes + fresh bookings → not stale", () => {
    recordPull("route:E450", 5);
    recordPull("bookings", 90);
    expect(checkPullStaleness().stale).toBe(false);
  });

  it("stale routes but fresh bookings → flags routes only (bookings pull no longer masks routes)", () => {
    recordPull("route:E450", 5, hoursAgo(30));
    recordPull("route:NPR-1", 3, hoursAgo(30));
    recordPull("bookings", 90); // fresh now
    const r = checkPullStaleness();
    expect(r.stale).toBe(true);
    expect(r.parts.some((p) => p.startsWith("routes"))).toBe(true);
    expect(r.parts.some((p) => p.startsWith("bookings"))).toBe(false);
  });

  it("import ledger records attempts (ok + partial)", () => {
    logImport("bookings", true, { rowsIn: 90, rowsWritten: 90 });
    logImport("bookings", false, { rowsIn: 40, rowsWritten: 40, detail: "partial pull" });
    const rows = getRecentImports().filter((r) => r.source === "bookings");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.some((r) => !r.ok && r.detail?.includes("partial"))).toBe(true);
  });
});
