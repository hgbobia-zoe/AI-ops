// The calculator's project picker: a project already on a route gets its stop's street address and its
// routed delivery and pickup dates (Goodshuffle's project search only gives city + ZIP and one date).
import { describe, expect, it } from "vitest";
import { GET } from "./route";
import { getDb } from "@/lib/db";

describe("GET /api/pricing/projects/search", () => {
  it("adds the routed street address and pickup date when the project is on a route", async () => {
    const db = getDb();
    db.prepare("INSERT INTO bookings (booking_id, event_name, event_date, status_label, signed, location, updated_at) VALUES (?,?,?,?,?,?,?)").run(
      "990001", "Fixture Gala", "2027-04-09", "Contract Signed", 1, "Testville, VA 20000", "x",
    );
    db.prepare("INSERT INTO bookings (booking_id, event_name, event_date, status_label, signed, location, updated_at) VALUES (?,?,?,?,?,?,?)").run(
      "990002", "Fixture Picnic", "2027-05-01", "Quote Sent", 0, "Otherville, MD 20001", "x",
    );
    db.prepare("INSERT INTO routes (route_id, truck_id, date, status, updated_at) VALUES (?,?,?,?,?)").run("RD", "T1", "2027-04-09", "ready", "x");
    db.prepare("INSERT INTO routes (route_id, truck_id, date, status, updated_at) VALUES (?,?,?,?,?)").run("RP", "T1", "2027-04-10", "ready", "x");
    const ins = db.prepare("INSERT INTO stops (stop_id, route_id, sequence, state, kind, address, tx_id) VALUES (?,?,?,?,?,?,?)");
    ins.run("s1", "RD", 1, "Waiting", "delivery", "100 Fixture Rd, Testville, VA 20000", "990001");
    ins.run("s2", "RP", 1, "Waiting", "pickup", "100 Fixture Rd, Testville, VA 20000", "990001");

    const res = await GET(new Request("http://localhost/api/pricing/projects/search?q=Fixture"));
    const { projects } = (await res.json()) as { projects: Array<Record<string, unknown>> };
    const gala = projects.find((p) => p.id === "990001")!;
    expect(gala.streetAddress).toBe("100 Fixture Rd, Testville, VA 20000");
    expect(gala.eventDate).toBe("2027-04-09");
    expect(gala.pickupDate).toBe("2027-04-10");
    const picnic = projects.find((p) => p.id === "990002")!;
    expect(picnic.streetAddress).toBeNull();
    expect(picnic.pickupDate).toBeNull();
    expect(picnic.location).toBe("Otherville, MD 20001");
  });
});

describe("picker fallback to Goodshuffle's own address and dates", () => {
  it("uses the stored street and timeline dates when the project is not routed", async () => {
    getDb()
      .prepare(
        "INSERT INTO bookings (booking_id, event_name, event_date, status_label, signed, location, street_address, delivery_date, pickup_date, delivers, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run("990003", "Fixture Wedding", "2027-06-05", "Contract Signed", 1, "Farville, VA 20002", "7 Orchard Ln", "2027-06-05", "2027-06-06", 1, "x");
    const res = await GET(new Request("http://localhost/api/pricing/projects/search?q=Wedding"));
    const { projects } = (await res.json()) as { projects: Array<Record<string, unknown>> };
    expect(projects[0]).toMatchObject({ id: "990003", streetAddress: "7 Orchard Ln, Farville, VA 20002", eventDate: "2027-06-05", pickupDate: "2027-06-06" });
  });
});

describe("the picker lists live projects only, grouped and newest first", () => {
  const ins = (id: string, status: string, over: { archived?: number; updatedAt?: string; venue?: string | null; location?: string } = {}) =>
    getDb()
      .prepare("INSERT INTO bookings (booking_id, event_name, status_label, signed, archived, venue, location, updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, `Pick ${id}`, status, /signed/i.test(status) ? 1 : 0, over.archived ?? 0, over.venue ?? null, over.location ?? "Town, MD 20000", over.updatedAt ?? "2026-11-11T22:00:00.000Z");

  it("drops archived, lost and deleted projects; New > Quote sent > Signed; newest first", async () => {
    getDb().prepare("DELETE FROM bookings").run();
    ins("880001", "Quote Sent");
    ins("880005", "Quote Sent");
    ins("880002", "New Project");
    ins("880006", "New Project");
    ins("880003", "Contract Signed");
    ins("880007", "Unsigned Changes");
    ins("880004", "Quote Sent", { archived: 1 }); // archived
    ins("880008", "Lost"); // lost
    ins("880009", "New Project", { updatedAt: "2026-11-09T10:00:00.000Z" }); // gone from Goodshuffle (no longer pulled)

    const res = await GET(new Request("http://localhost/api/pricing/projects/search?q="));
    const { projects } = (await res.json()) as { projects: Array<{ id: string; status: string }> };
    expect(projects.map((p) => p.id)).toEqual(["880006", "880002", "880005", "880001", "880007", "880003"]);
    expect(projects[0].status).toBe("New Project");

    const typed = await GET(new Request("http://localhost/api/pricing/projects/search?q=88000"));
    const t = (await typed.json()) as { projects: Array<{ id: string }> };
    expect(t.projects.map((p) => p.id)).not.toContain("880004");
  });

  it("uses Goodshuffle's venue label as the street when the pull has not stored one yet", async () => {
    getDb().prepare("DELETE FROM bookings").run();
    ins("880010", "New Project", { venue: "20631 Highland Hall Dr", location: "Montgomery Village, MD 20886" });
    ins("880011", "New Project", { venue: "Stone Tower Winery", location: "Leesburg, VA 20175" });
    const res = await GET(new Request("http://localhost/api/pricing/projects/search?q=Pick"));
    const { projects } = (await res.json()) as { projects: Array<{ id: string; streetAddress: string | null }> };
    expect(projects.find((p) => p.id === "880010")?.streetAddress).toBe("20631 Highland Hall Dr, Montgomery Village, MD 20886");
    expect(projects.find((p) => p.id === "880011")?.streetAddress).toBeNull(); // a venue name is not a street
  });
});
