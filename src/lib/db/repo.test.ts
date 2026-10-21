import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  advanceNextStop,
  enqueueEtaLinkMint,
  getAllBookings,
  getBookingsRevenueInRange,
  getQuoteStageSnapshot,
  getRoute,
  insertEventIfNew,
  saveBookings,
  searchBookings,
  writeRoute,
} from "./repo";
import { getDb } from "@/lib/db";
import type { Route } from "@/lib/types";

// DATABASE_PATH is ":memory:" (see vitest.config.ts), so this hits a throwaway DB.

function sampleRoute(truckId = "NPR-1"): Route {
  const routeId = `R-2026-08-30-${truckId}`;
  return {
    routeId,
    date: "2026-08-30",
    truckId,
    status: "ready",
    stops: [
      {
        stopId: `${routeId}-S1`,
        routeId,
        customerId: "C1",
        sequence: 1,
        state: "Waiting",
        custName: "Acme Events Co.",
        custPhone: "+15555550111",
        address: "1200 Oak St",
      },
      {
        stopId: `${routeId}-S2`,
        routeId,
        customerId: "C2",
        sequence: 2,
        state: "Waiting",
        custName: "Riverside Weddings",
        custPhone: "+15555550122",
        address: "88 Lakeview Dr",
        dayOfName: "Jordan",
        dayOfPhone: "+15555550190",
      },
    ],
  };
}

describe("writeRoute / getRoute", () => {
  it("round-trips a route with its stops, including the day-of coordinator", () => {
    writeRoute(sampleRoute());
    const got = getRoute("NPR-1");
    expect(got?.stops).toHaveLength(2);
    expect(got?.stops[0].custName).toBe("Acme Events Co.");
    expect(got?.stops[1].dayOfName).toBe("Jordan");
    expect(got?.stops[1].dayOfPhone).toBe("+15555550190");
    expect(got?.stops[0].dayOfName).toBeUndefined();
  });

  it("replaces stops on re-write instead of duplicating them", () => {
    writeRoute(sampleRoute("NPR-2"));
    writeRoute(sampleRoute("NPR-2")); // same route again
    expect(getRoute("NPR-2")?.stops).toHaveLength(2);
  });

  it("keeps stop ids unique across two trucks (no global-PK collision)", () => {
    writeRoute(sampleRoute("NPR-1"));
    // A different truck's route must not throw on its own S1/S2 ids.
    expect(() => writeRoute(sampleRoute("E450"))).not.toThrow();
    expect(getRoute("E450")?.stops).toHaveLength(2);
  });
});

describe("enqueueEtaLinkMint — reuse vs re-enqueue at the click", () => {
  const base = (stopId: string) => ({
    stopId,
    truckId: "E450",
    truckLabel: "Ford E450",
    address: "111 Rockville Pike",
    lat: 39.08,
    lng: -77.14,
    etaHours: null,
    startISO: new Date().toISOString(),
    endISO: new Date(Date.now() + 8 * 3600 * 1000).toISOString(), // window still open
  });

  it("reuses a FRESH pending row (idempotent — a re-tap never double-mints)", () => {
    const a = enqueueEtaLinkMint(base("EL-STOP-fresh"));
    const b = enqueueEtaLinkMint({ ...base("EL-STOP-fresh"), maxPendingAgeMs: 10 * 60 * 1000 });
    expect(a.status).toBe("pending");
    expect(b.id).toBe(a.id); // same row reused
  });

  it("RE-ENQUEUES an over-age pending row (stale, likely never drained) when maxPendingAgeMs is set", () => {
    const a = enqueueEtaLinkMint(base("EL-STOP-stale"));
    // Age the pending row 1h into the past (as if the pre-mint tick enqueued it while the poller was down).
    getDb()
      .prepare("UPDATE eta_links SET created_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 3600 * 1000).toISOString(), a.id);

    const b = enqueueEtaLinkMint({ ...base("EL-STOP-stale"), maxPendingAgeMs: 10 * 60 * 1000 });
    expect(b.id).not.toBe(a.id); // a fresh pending row, not the stale one
    expect(b.status).toBe("pending");
  });

  it("without maxPendingAgeMs an old pending row is still reused (pre-mint tick behavior unchanged)", () => {
    const a = enqueueEtaLinkMint(base("EL-STOP-nolimit"));
    getDb()
      .prepare("UPDATE eta_links SET created_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 3600 * 1000).toISOString(), a.id);
    const b = enqueueEtaLinkMint(base("EL-STOP-nolimit")); // no maxPendingAgeMs
    expect(b.id).toBe(a.id);
  });

  it("an over-age MINTED row is always reused (a live link is not stale)", () => {
    const a = enqueueEtaLinkMint(base("EL-STOP-minted"));
    getDb()
      .prepare("UPDATE eta_links SET status = 'minted', url = ?, created_at = ? WHERE id = ?")
      .run("https://ignition.zonarsystems.com/etaLink/live", new Date(Date.now() - 3600 * 1000).toISOString(), a.id);
    const b = enqueueEtaLinkMint({ ...base("EL-STOP-minted"), maxPendingAgeMs: 10 * 60 * 1000 });
    expect(b.id).toBe(a.id);
    expect(b.status).toBe("minted");
    expect(b.url).toBe("https://ignition.zonarsystems.com/etaLink/live");
  });
});

describe("insertEventIfNew", () => {
  it("dedupes on the idempotency key (double-tap / offline replay)", () => {
    const e = {
      eventId: "E1",
      idempotencyKey: "idem-123",
      action: "ARRIVED",
      ts: "2026-08-30T12:00:00Z",
    };
    expect(insertEventIfNew(e)).toBe(true);
    expect(insertEventIfNew({ ...e, eventId: "E2" })).toBe(false);
  });
});

describe("searchBookings", () => {
  const seed = () =>
    saveBookings([
      { bookingId: "90001", eventName: "Garden Wedding", clientName: "Alice Nguyen", statusLabel: "Quote", contractTotal: 2000, dateCreated: "2026-09-01" },
      { bookingId: "90002", eventName: "Corporate Gala", clientName: "Bob Smith", statusLabel: "Signed", signed: true, contractTotal: 5000, dateCreated: "2026-09-05" },
      { bookingId: "90003", eventName: "Beach Party", clientName: "Carol Wedding-Planner", statusLabel: "Lost", contractTotal: 1000, dateCreated: "2026-09-10" },
    ]);

  it("matches by event name (case-insensitive)", () => {
    seed();
    const ids = searchBookings("wedding").map((b) => b.bookingId);
    expect(ids).toContain("90001"); // "Garden Wedding"
    expect(ids).toContain("90003"); // client "Carol Wedding-Planner"
    expect(ids).not.toContain("90002");
  });

  it("matches by project number (id substring)", () => {
    seed();
    const ids = searchBookings("90002").map((b) => b.bookingId);
    expect(ids).toEqual(["90002"]);
  });

  it("matches by customer name and ranks cancelled/lost last", () => {
    seed();
    const res = searchBookings("a"); // matches all three names
    const ids = res.map((b) => b.bookingId);
    expect(ids).toContain("90001");
    // The lost booking (90003) must sort after the open/signed ones.
    expect(ids.indexOf("90003")).toBe(ids.length - 1);
  });

  it("returns nothing for a blank query", () => {
    expect(searchBookings("   ")).toEqual([]);
  });
});

describe("advanceNextStop", () => {
  it("moves the next stop by sequence into EnRoute and returns it", () => {
    writeRoute(sampleRoute("NPR-1"));
    const routeId = "R-2026-08-30-NPR-1";
    const next = advanceNextStop(routeId, 1);
    expect(next?.sequence).toBe(2);
    expect(next?.state).toBe("EnRoute");
    expect(next?.dayOfName).toBe("Jordan");
    // Nothing after the last stop.
    expect(advanceNextStop(routeId, 2)).toBeNull();
  });
});

// ── Backend newest-first + current-operating-year boundary (non-financial vs financial) ───────────────
// Pin the operating-year boundary to 2026 via the override so these are deterministic regardless of the
// real clock. Exercises: a NON-FINANCIAL query excludes a prior-year row but keeps current + future +
// undated; a FINANCIAL query still sees the prior-year row (full multi-year history); newest-first order.
describe("current-operating-year boundary + newest-first ordering", () => {
  const prevEnv = process.env.OPERATING_YEAR_START;
  beforeAll(() => {
    process.env.OPERATING_YEAR_START = "2026";
  });
  afterAll(() => {
    if (prevEnv === undefined) delete process.env.OPERATING_YEAR_START;
    else process.env.OPERATING_YEAR_START = prevEnv;
  });

  it("getQuoteStageSnapshot (non-financial) drops prior-year quotes but keeps current/future/undated", () => {
    const base = getQuoteStageSnapshot();
    // A 2024 OPEN quote — prior year → must NOT change the active-stage counts.
    saveBookings([{ bookingId: "OY-2024", eventName: "Old Gala", statusLabel: "Quote", signed: false, eventDate: "2024-05-01" }]);
    const afterOld = getQuoteStageSnapshot();
    expect(afterOld.stageQuoteSent).toBe(base.stageQuoteSent);

    // A 2027 OPEN quote — future-dated → MUST be included (not "only 2026").
    saveBookings([{ bookingId: "OY-2027", eventName: "Future Gala", statusLabel: "Quote", signed: false, eventDate: "2027-03-01" }]);
    const afterFuture = getQuoteStageSnapshot();
    expect(afterFuture.stageQuoteSent).toBe(afterOld.stageQuoteSent + 1);

    // An UNDATED open quote (brand-new, no event date yet) → kept.
    saveBookings([{ bookingId: "OY-UND", eventName: "Undated Quote", statusLabel: "Quote", signed: false, eventDate: null }]);
    const afterUndated = getQuoteStageSnapshot();
    expect(afterUndated.stageQuoteSent).toBe(afterFuture.stageQuoteSent + 1);
  });

  it("getBookingsRevenueInRange (financial) still returns the prior-year row — full history, not year-bounded", () => {
    saveBookings([
      { bookingId: "FIN-2024", eventName: "Old Signed", statusLabel: "Signed", signed: true, grandTotal: 7777, eventDate: "2024-07-04" },
    ]);
    const rev = getBookingsRevenueInRange("2024-01-01", "2024-12-31");
    expect(rev.signedCount).toBeGreaterThanOrEqual(1);
    expect(rev.signed ?? 0).toBeGreaterThanOrEqual(7777);
  });

  it("getAllBookings presents newest event_date first", () => {
    saveBookings([
      { bookingId: "ORD-A", eventName: "A", eventDate: "2024-05-01" },
      { bookingId: "ORD-C", eventName: "C", eventDate: "2027-03-01" },
      { bookingId: "ORD-B", eventName: "B", eventDate: "2026-07-01" },
    ]);
    const mine = getAllBookings()
      .filter((b) => ["ORD-A", "ORD-B", "ORD-C"].includes(b.bookingId))
      .map((b) => b.bookingId);
    expect(mine).toEqual(["ORD-C", "ORD-B", "ORD-A"]); // 2027, 2026, 2024 — descending
  });
});
