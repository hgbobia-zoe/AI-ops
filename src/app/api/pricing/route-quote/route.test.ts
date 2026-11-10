// Handler-level tests for POST /api/pricing/route-quote: anchor selection per leg, eligibility, trip
// construction and recalculation, on sanitized fixtures in the in-memory test DB with a deterministic fake
// geo (no network). Points sit (dx east, dy north) miles from the warehouse; driving distance is the
// straight line x 1.2, at 30 mph. The venue is 25 mi west by air = 30.0 road miles one way.
import { beforeEach, describe, expect, it, vi } from "vitest";

const geo = vi.hoisted(() => {
  const WH = { lat: 39.0638628, lng: -77.1127462 }; // must match WAREHOUSE_COORDS
  const LNG_MI = 69.0 * Math.cos((WH.lat * Math.PI) / 180);
  const pt = (dx: number, dy: number) => ({ lat: WH.lat + dy / 69.0, lng: WH.lng + dx / LNG_MI });
  const hav = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
    const R = 3958.7613;
    const r = (d: number) => (d * Math.PI) / 180;
    const s = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  };
  const addrBook = new Map<string, { lat: number; lng: number }>();
  const failing = new Set<string>(); // pair keys whose routing lookup fails
  const key = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
    [a, b].map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).sort().join("|");
  return { WH, pt, hav, addrBook, failing, key };
});

vi.mock("@/lib/eta/geo", () => ({
  geocode: async (a: string) => geo.addrBook.get(a.trim()) ?? null,
  driveTime: async (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
    if (geo.failing.has(geo.key(a, b))) return null;
    const miles = geo.hav(a, b) * 1.2;
    return { meters: miles * 1609.344, seconds: (miles / 30) * 3600 };
  },
}));

import { POST } from "./route";
import { getDb } from "@/lib/db";
import { deliveryLegFee } from "@/lib/pricing/delivery";
import { pricingConfig } from "@/lib/pricing/config";
import { WAREHOUSE_COORDS } from "@/lib/pricing/warehouse";
import { looksCityLevel } from "@/lib/pricing/address";

const D = "2027-04-09"; // delivery day
const P = "2027-04-10"; // pickup day (next morning)
const VENUE = "100 Fixture Rd, Testville, VA 20000";
const SUB = 1000;
geo.addrBook.set(VENUE, geo.pt(-25, 0));

function reset() {
  const db = getDb();
  db.prepare("DELETE FROM stops").run();
  db.prepare("DELETE FROM routes").run();
  db.prepare("DELETE FROM bookings").run();
  (globalThis as { __zoeDriveCache?: Map<string, unknown> }).__zoeDriveCache?.clear();
  geo.failing.clear();
}
function route(id: string, truck: string, date: string, status = "ready") {
  getDb()
    .prepare("INSERT INTO routes (route_id, truck_id, date, status, updated_at) VALUES (?,?,?,?,?)")
    .run(id, truck, date, status, "2026-11-01T00:00:00Z");
}
function stop(o: { id: string; route: string; seq: number; dx: number; dy: number; kind?: string; tx?: string; state?: string }) {
  const addr = `${o.seq}0 Fixture St ${o.id}`;
  geo.addrBook.set(addr, geo.pt(o.dx, o.dy));
  getDb()
    .prepare(
      "INSERT INTO stops (stop_id, route_id, sequence, state, cust_name, kind, address, planned_window, tx_id) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run(o.id, o.route, o.seq, o.state ?? "Waiting", `Fixture ${o.id}`, o.kind ?? "delivery", addr, "10:00-12:00", o.tx ?? `TX-${o.id}`);
}
function booking(id: string, status: string, archived = 0) {
  getDb()
    .prepare("INSERT INTO bookings (booking_id, event_name, event_date, status_label, signed, archived, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, `Fixture ${id}`, D, status, 1, archived, "2026-11-01T00:00:00Z");
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function quote(body: Record<string, unknown>): Promise<any> {
  const res = await POST(
    new Request("http://localhost/api/pricing/route-quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return res.json();
}
const base = { address: VENUE, subtotal: SUB, mode: "round_trip", projectId: "SELF" };
const standardLeg = deliveryLegFee(30, SUB, pricingConfig()).total; // 152.30 at the default formula

beforeEach(reset);

it("fixture sanity: the fake warehouse is the real one and the venue is 30.0 road miles out", async () => {
  expect(WAREHOUSE_COORDS).toEqual(geo.WH);
  const j = await quote({ ...base, eventDate: D });
  expect(j.warehouseMiles).toBe(30);
  expect(standardLeg).toBe(152.3);
});

describe("each leg is anchored on its own day", () => {
  it("neither leg matches: both legs standard, and it says no routes exist yet", async () => {
    const j = await quote({ ...base, eventDate: D, pickupDate: P });
    expect(j.legs.dropOff.pricingMode).toBe("STANDARD");
    expect(j.legs.pickup.pricingMode).toBe("STANDARD");
    expect(j.quote.dropOff.total).toBe(standardLeg);
    expect(j.quote.pickup.total).toBe(standardLeg);
    expect(j.legs.dropOff.reasons.join(" ")).toMatch(/No routes are scheduled on 2027-04-09/);
  });

  it("only the delivery day matches: drop-off shares a route, pickup stays standard", async () => {
    route("R-D", "NPR-1", D);
    stop({ id: "d1", route: "R-D", seq: 1, dx: -22, dy: 0 });
    const j = await quote({ ...base, eventDate: D, pickupDate: P });
    expect(j.legs.dropOff.pricingMode).toBe("ROUTE_OPTIMIZED");
    expect(j.legs.dropOff.billableMiles).toBe(7.21);
    expect(j.quote.dropOff.total).toBe(96.56);
    expect(j.legs.pickup.pricingMode).toBe("STANDARD");
    expect(j.quote.pickup.total).toBe(standardLeg);
    expect(j.quote.total).toBe(Math.round((96.56 + standardLeg) * 100) / 100);
  });

  it("only the pickup day matches: drop-off standard, pickup shares a route", async () => {
    route("R-P", "E450", P);
    stop({ id: "p1", route: "R-P", seq: 1, dx: -22, dy: 0, kind: "pickup" });
    const j = await quote({ ...base, eventDate: D, pickupDate: P });
    expect(j.legs.dropOff.pricingMode).toBe("STANDARD");
    expect(j.quote.dropOff.total).toBe(standardLeg);
    expect(j.legs.pickup.pricingMode).toBe("ROUTE_OPTIMIZED");
    expect(j.legs.pickup.anchor.id).toBe("TX-p1");
    expect(j.quote.pickup.total).toBe(96.56);
  });

  it("both days match: each leg uses its own day's anchor and miles", async () => {
    route("R-D", "NPR-1", D);
    stop({ id: "d1", route: "R-D", seq: 1, dx: -22, dy: 0 });
    route("R-P", "E450", P);
    stop({ id: "p1", route: "R-P", seq: 1, dx: -24, dy: 0, kind: "pickup" });
    const j = await quote({ ...base, eventDate: D, pickupDate: P });
    expect(j.legs.dropOff.anchor.id).toBe("TX-d1");
    expect(j.legs.pickup.anchor.id).toBe("TX-p1");
    expect(j.legs.pickup.billableMiles).toBeLessThan(j.legs.dropOff.billableMiles);
    expect(j.quote.dropOffMiles).toBe(j.legs.dropOff.billableMiles);
    expect(j.quote.pickupMiles).toBe(j.legs.pickup.billableMiles);
    // The push sends one per-leg amount: the average, so the round trip total is preserved.
    expect(j.perLeg).toBe(Math.round(((j.quote.dropOff.total + j.quote.pickup.total) / 2) * 100) / 100);
  });

  it("no pickup date means a same-day pickup: both legs read the delivery day", async () => {
    route("R-D", "NPR-1", D);
    stop({ id: "d1", route: "R-D", seq: 1, dx: -22, dy: 0 });
    const j = await quote({ ...base, eventDate: D });
    expect(j.legs.pickup.date).toBe(D);
    expect(j.legs.pickup.anchor.id).toBe("TX-d1");
    expect(j.quote.pickup.total).toBe(j.quote.dropOff.total);
  });

  it("pickup only prices just the pickup leg on the pickup day", async () => {
    route("R-P", "E450", P);
    stop({ id: "p1", route: "R-P", seq: 1, dx: -22, dy: 0, kind: "pickup" });
    const j = await quote({ ...base, mode: "pickup", eventDate: D, pickupDate: P });
    expect(j.legs.dropOff).toBeNull();
    expect(j.quote.dropOff).toBeNull();
    expect(j.legs.pickup.pricingMode).toBe("ROUTE_OPTIMIZED");
    expect(j.perLeg).toBe(j.quote.pickup.total);
  });
});

describe("eligibility", () => {
  it("closest stop belongs to a Lost project: the farther eligible stop anchors instead", async () => {
    route("R-D", "NPR-1", D);
    stop({ id: "lost", route: "R-D", seq: 1, dx: -24, dy: 0.5, tx: "B-LOST" });
    stop({ id: "ok", route: "R-D", seq: 2, dx: -20, dy: 3, tx: "B-OK" });
    booking("B-LOST", "Lost");
    booking("B-OK", "Contract Signed");
    const j = await quote({ ...base, eventDate: D });
    expect(j.legs.dropOff.anchor.id).toBe("B-OK");
    expect(j.legs.dropOff.billableMiles).toBe(12.75);
    expect(j.quote.dropOff.total).toBe(113.12);
  });

  it("cancelled and archived projects are skipped too", async () => {
    route("R-D", "NPR-1", D);
    stop({ id: "c", route: "R-D", seq: 1, dx: -24, dy: 0.5, tx: "B-CANC" });
    stop({ id: "a", route: "R-D", seq: 2, dx: -24.5, dy: 0.2, tx: "B-ARCH" });
    stop({ id: "ok", route: "R-D", seq: 3, dx: -20, dy: 3, tx: "B-OK" });
    booking("B-CANC", "Cancelled");
    booking("B-ARCH", "Contract Signed", 1);
    booking("B-OK", "Contract Signed");
    const j = await quote({ ...base, eventDate: D });
    expect(j.legs.dropOff.anchor.id).toBe("B-OK");
  });

  it("closest stop is in state Exception: the farther eligible stop anchors instead", async () => {
    route("R-D", "NPR-1", D);
    stop({ id: "exc", route: "R-D", seq: 1, dx: -24, dy: 0.5, state: "Exception" });
    stop({ id: "ok2", route: "R-D", seq: 2, dx: -20, dy: 3 });
    const j = await quote({ ...base, eventDate: D });
    expect(j.legs.dropOff.anchor.id).toBe("TX-ok2");
    expect(j.legs.dropOff.billableMiles).toBe(12.75);
  });

  it("the quote's own routed stop never anchors it", async () => {
    route("R-D", "NPR-1", D);
    stop({ id: "self", route: "R-D", seq: 1, dx: -25, dy: 0.01, tx: "231000001" });
    stop({ id: "other", route: "R-D", seq: 2, dx: -20, dy: 3 });
    const j = await quote({ ...base, eventDate: D, projectId: "231000001" });
    expect(j.legs.dropOff.anchor.id).toBe("TX-other");
  });
});

describe("trip construction", () => {
  it("a truck with two routes on one day is two trips, not one merged sequence", async () => {
    route("R-A", "NPR-1", D);
    stop({ id: "A1", route: "R-A", seq: 1, dx: -22, dy: 0 });
    route("R-B", "NPR-1", D);
    stop({ id: "B1", route: "R-B", seq: 1, dx: -25, dy: 10 });
    const j = await quote({ ...base, eventDate: D });
    // Merged, the never-driven A1 to B1 gap gave 3.08 mi. Split, the best real insertion is 7.21 mi.
    expect(j.legs.dropOff.billableMiles).toBe(7.21);
    expect(j.legs.dropOff.anchor.truckId).toBe("NPR-1");
  });

  it("a mid-route stop beyond the radius stays in the sequence (no fictional gap)", async () => {
    route("RF", "NPR-1", D);
    stop({ id: "A1", route: "RF", seq: 1, dx: -22, dy: 0 });
    stop({ id: "X", route: "RF", seq: 2, dx: 15, dy: 0 }); // 40 mi from the venue
    stop({ id: "B1", route: "RF", seq: 3, dx: -25, dy: 10 });
    const j = await quote({ ...base, eventDate: D });
    expect(j.legs.dropOff.billableMiles).toBe(7.21); // was 3.08 when X was dropped before building the trip
  });

  it("a route with no stop near the venue is not checked", async () => {
    route("R-FAR", "E450", D);
    stop({ id: "far", route: "R-FAR", seq: 1, dx: 20, dy: 0 });
    const j = await quote({ ...base, eventDate: D });
    expect(j.legs.dropOff.pricingMode).toBe("STANDARD");
    expect(j.legs.dropOff.reasons.join(" ")).toMatch(/1 route\(s\) on this date; 0 with a stop within 15 mi/);
  });
});

describe("recalculation", () => {
  it("a routing failure is not cached: the recalc keeps the warning, then heals when routing is back", async () => {
    route("R1", "NPR-1", D);
    stop({ id: "c1", route: "R1", seq: 1, dx: -22, dy: 0 });
    geo.failing.add(geo.key(geo.pt(-22, 0), geo.pt(-25, 0))); // anchor to venue fails
    const first = await quote({ ...base, eventDate: D });
    const recalc = await quote({ ...base, eventDate: D });
    const warn = /could not be verified/;
    expect(first.legs.dropOff.reasons.join(" ")).toMatch(warn);
    expect(recalc.legs.dropOff.reasons.join(" ")).toMatch(warn);
    expect(recalc.legs.dropOff.billableMiles).toBe(first.legs.dropOff.billableMiles);
    geo.failing.clear();
    const healed = await quote({ ...base, eventDate: D });
    expect(healed.legs.dropOff.reasons.join(" ")).not.toMatch(warn);
    expect(healed.legs.dropOff.billableMiles).toBe(7.21);
  });

  it("identical inputs give identical output", async () => {
    route("R-D", "NPR-1", D);
    stop({ id: "d1", route: "R-D", seq: 1, dx: -22, dy: 0 });
    const a = await quote({ ...base, eventDate: D, pickupDate: P });
    const b = await quote({ ...base, eventDate: D, pickupDate: P });
    expect(a).toEqual(b);
  });

  it("typed miles win over the geocoded distance when the rep overrides them", async () => {
    const plain = await quote({ ...base, miles: 45, eventDate: D });
    expect(plain.distanceSource).toBe("geocoded");
    expect(plain.billableMiles).toBe(30);
    const typed = await quote({ ...base, miles: 45, milesOverride: true, eventDate: D });
    expect(typed.distanceSource).toBe("manual");
    expect(typed.quote.dropOffMiles).toBe(45);
    expect(typed.quote.pickupMiles).toBe(45);
    expect(typed.legs.dropOff.reasons.join(" ")).toMatch(/45 mi you typed/);
  });

  it("returns the live formula even with nothing to price (the calculator's fallback reads it)", async () => {
    const j = await quote({});
    expect(j.resolved).toBe(false);
    expect(j.formula.baseFee).toBe(pricingConfig().baseFee);
  });
});

describe("address precision", () => {
  it("warns when the address is only a town and ZIP", async () => {
    geo.addrBook.set("Testville, VA 20000", geo.pt(-24, 0));
    const city = await quote({ ...base, address: "Testville, VA 20000", eventDate: D });
    expect(city.addressPrecision).toBe("city");
    expect(city.warnings.join(" ")).toMatch(/no street number/);
    const street = await quote({ ...base, eventDate: D });
    expect(street.addressPrecision).toBe("street");
    expect(street.warnings).toEqual([]);
  });

  it("looksCityLevel", () => {
    expect(looksCityLevel("Leesburg, VA 20175")).toBe(true);
    expect(looksCityLevel("Leesburg, VA 20175 Loudoun")).toBe(true);
    expect(looksCityLevel("802 Childrens Center Rd SW, Leesburg, VA 20175")).toBe(false);
    expect(looksCityLevel("12B Main St, Bethesda, MD")).toBe(false);
  });
});
