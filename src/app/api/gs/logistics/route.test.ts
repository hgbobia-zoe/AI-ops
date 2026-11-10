// The pull posts each upcoming signed project's raw timeline legs; the server parses and stores them.
import { beforeEach, describe, expect, it } from "vitest";
import { POST } from "./route";
import { getDb } from "@/lib/db";
import { saveBookings } from "@/lib/db/repo";

const row = (id: string) =>
  getDb().prepare("SELECT street_address, delivery_date, delivery_window, pickup_date, delivers FROM bookings WHERE booking_id = ?").get(id) as Record<string, unknown>;

async function post(body: unknown) {
  const res = await POST(new Request("http://localhost/api/gs/logistics", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, json: (await res.json()) as { updated: number } };
}

beforeEach(() => {
  getDb().prepare("DELETE FROM bookings").run();
  saveBookings([{ bookingId: "880001", eventName: "Fixture", eventDate: "2027-04-09", signed: true, streetAddress: "100 Fixture Rd" }]);
});

describe("POST /api/gs/logistics", () => {
  it("parses and stores the legs", async () => {
    const r = await post({
      logistics: [
        {
          bookingId: "880001",
          startDate: "2027-04-09",
          events: [
            { type: "lineItemGroup", dateLabel: "Apr 9, 2027" },
            { type: "logisticsDelivery", dateLabel: "Saturday, 4/10 [8:00 AM - 10:00 AM]" },
            { type: "logisticsDelivery", dateLabel: "Friday, 4/9 [10:00 AM - 12:00 PM]" },
          ],
        },
      ],
    });
    expect(r.json.updated).toBe(1);
    expect(row("880001")).toMatchObject({ delivery_date: "2027-04-09", delivery_window: "10:00 AM - 12:00 PM", pickup_date: "2027-04-10", delivers: 1 });
  });

  it("an empty timeline read never blanks what we know", async () => {
    await post({ logistics: [{ bookingId: "880001", startDate: "2027-04-09", events: [{ type: "logisticsInStore", dateLabel: "Friday, 4/9 [10:00 AM - 1:00 PM]" }] }] });
    expect(row("880001").delivers).toBe(0);
    const r = await post({ logistics: [{ bookingId: "880001", events: [] }] });
    expect(r.json.updated).toBe(0);
    expect(row("880001").delivers).toBe(0);
  });

  it("a projects pull without streetAddress keeps the stored street", () => {
    saveBookings([{ bookingId: "880001", eventName: "Fixture", eventDate: "2027-04-09", signed: true }]);
    expect(row("880001").street_address).toBe("100 Fixture Rd");
    saveBookings([{ bookingId: "880001", eventName: "Fixture", eventDate: "2027-04-09", signed: true, streetAddress: "" }]);
    expect(row("880001").street_address).toBeNull();
  });
});
