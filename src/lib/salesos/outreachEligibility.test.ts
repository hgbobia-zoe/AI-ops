import { beforeEach, describe, expect, it } from "vitest";
import { outreachBlock } from "./outreachEligibility";
import { getDb } from "@/lib/db";
import { getPipelineLeads, saveBookings } from "@/lib/db/repo";
import { openQuoteCards } from "./bulkOutreach";
import { POST } from "@/app/api/gs/projects/route";

const TODAY = "2026-11-13";

describe("outreachBlock", () => {
  it("blocks archived, lost / cancelled / dead, no event date and a past event", () => {
    expect(outreachBlock({ archived: true, statusLabel: "Quote Sent", eventDate: "2027-01-01" }, TODAY)?.kind).toBe("archived");
    expect(outreachBlock({ archived: 1, eventDate: "2027-01-01" }, TODAY)?.kind).toBe("archived");
    for (const label of ["Lost", "Cancelled", "Dead lead"]) expect(outreachBlock({ statusLabel: label, eventDate: "2027-01-01" }, TODAY)?.kind).toBe("closed");
    expect(outreachBlock({ statusLabel: "Quote Sent", eventDate: null }, TODAY)).toEqual({ kind: "no_date", reason: "No event date on the project, a person should check it." });
    expect(outreachBlock({ statusLabel: "Quote Sent", eventDate: "" }, TODAY)?.kind).toBe("no_date");
    expect(outreachBlock({ statusLabel: "Quote Sent", eventDate: "2023-04-08" }, TODAY)?.kind).toBe("past_event");
  });

  it("lets an open quote with an event today or later through", () => {
    expect(outreachBlock({ archived: false, statusLabel: "Quote Sent", eventDate: TODAY }, TODAY)).toBeNull();
    expect(outreachBlock({ archived: 0, statusLabel: "Quote Sent", eventDate: "2027-06-12" }, TODAY)).toBeNull();
  });
});

describe("archived quotes stay off the board and out of outreach", () => {
  beforeEach(() => getDb().prepare("DELETE FROM bookings").run());

  // One of the projects texted on 2026-11-13 (Goodshuffle: Quote Sent, archived, event 2023-04-08).
  const OLD = { bookingId: "228804434", eventName: "Guehi - Petersburg", statusLabel: "Quote Sent", archived: true, eventDate: "2023-04-08", quoteSentDate: "2023-04-01", dateCreated: "2023-03-12", clientName: "G", clientPhone: "3015550100" };

  it("getPipelineLeads drops archived projects even when their event date is missing", () => {
    saveBookings([{ ...OLD, eventDate: null }, { bookingId: "LIVE1", eventName: "Live", statusLabel: "Quote Sent", eventDate: "2027-01-10", quoteSentDate: "2026-11-01", dateCreated: "2026-11-01" }]);
    const ids = getPipelineLeads(TODAY).map((b) => b.bookingId);
    expect(ids).toContain("LIVE1");
    expect(ids).not.toContain("228804434");
    expect(openQuoteCards().map((c) => c.id)).not.toContain("228804434");
  });

  it("a dateless re-pull can't reopen an archived 2023 quote", async () => {
    saveBookings([OLD]);
    // What a pull that can't read Goodshuffle's dates sends: the same projects, every date blank.
    const projects = [OLD, ...[1, 2, 3, 4, 5].map((i) => ({ ...OLD, bookingId: `ARCH${i}` }))].map((p) => ({
      bookingId: p.bookingId, eventName: p.eventName, statusLabel: "Quote Sent", archived: true, eventDate: null, quoteSentDate: null, dateCreated: null,
    }));
    const res = await POST(new Request("http://localhost/api/gs/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projects }) }));
    expect(res.status).toBe(200);
    const row = getDb().prepare("SELECT event_date, archived FROM bookings WHERE booking_id = '228804434'").get() as { event_date: string | null; archived: number };
    expect(row).toEqual({ event_date: "2023-04-08", archived: 1 });
    expect(getPipelineLeads(TODAY).map((b) => b.bookingId)).not.toContain("228804434");
    expect(openQuoteCards()).toHaveLength(0);
  });
});
