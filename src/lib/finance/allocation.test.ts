import { describe, it, expect } from "vitest";
import { allocateDriverLabor, type AllocRoute } from "./allocation";

const shift = (userId: string, startH: number, endH: number) => ({ userId, startUnix: startH * 3600, endUnix: endH * 3600 });

describe("driver labor allocation", () => {
  it("splits a driver's day cost across a route's events by stop share", () => {
    const routes: AllocRoute[] = [{ routeId: "R1", date: "D", driverId: "1", driverName: "Al", stops: [{ txId: "A" }, { txId: "A" }, { txId: "B" }] }];
    const entries = allocateDriverLabor(routes, [shift("1", 8, 12)], (u) => (u === "1" ? 25 : null), "D"); // 4h @ $25 = $100
    const a = entries.find((e) => e.eventId === "A")!;
    const b = entries.find((e) => e.eventId === "B")!;
    expect(a.amount).toBeCloseTo((4 * (2 / 3)) * 25, 1); // A has 2/3 of stops
    expect(b.amount).toBeCloseTo((4 * (1 / 3)) * 25, 1);
    expect((a.amount ?? 0) + (b.amount ?? 0)).toBeCloseTo(100, 1); // fully allocated
    expect(a.amountStatus).toBe("ACTUAL");
  });

  it("is UNAVAILABLE (never 0) when no rate is on file", () => {
    const entries = allocateDriverLabor([{ routeId: "R1", date: "D", driverId: "1", stops: [{ txId: "A" }] }], [shift("1", 8, 12)], () => null, "D");
    expect(entries[0].amount).toBeNull();
    expect(entries[0].amountStatus).toBe("UNAVAILABLE");
  });

  it("no driver → nothing; no identified events → nothing", () => {
    expect(allocateDriverLabor([{ routeId: "R1", date: "D", stops: [{ txId: "A" }] }], [], () => 25, "D")).toHaveLength(0);
    expect(allocateDriverLabor([{ routeId: "R1", date: "D", driverId: "1", stops: [{}] }], [shift("1", 8, 12)], () => 25, "D")).toHaveLength(0);
  });

  it("splits one driver's shift across two routes", () => {
    const routes: AllocRoute[] = [
      { routeId: "R1", date: "D", driverId: "1", stops: [{ txId: "A" }] },
      { routeId: "R2", date: "D", driverId: "1", stops: [{ txId: "B" }] },
    ];
    const entries = allocateDriverLabor(routes, [shift("1", 8, 12)], () => 25, "D"); // 4h/2 routes = 2h each = $50
    expect(entries.find((e) => e.eventId === "A")!.amount).toBeCloseTo(50, 1);
    expect(entries.find((e) => e.eventId === "B")!.amount).toBeCloseTo(50, 1);
  });
});
