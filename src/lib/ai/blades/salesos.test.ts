import { describe, expect, it } from "vitest";
import { scoreLostQuotes } from "./salesos";
import type { BookingView } from "@/lib/db/repo";

function bv(partial: Partial<BookingView>): BookingView {
  // Only the fields scoreLostQuotes reads matter; the rest are filled to satisfy the type loosely.
  return {
    bookingId: "b1",
    clientName: "Client",
    eventName: "Event",
    eventDate: null,
    grandTotal: null,
    signed: false,
    statusLabel: "Lost",
    ...partial,
  } as BookingView;
}

describe("scoreLostQuotes", () => {
  const today = "2026-10-06";

  it("keeps only upcoming events within the window", () => {
    const rows = [
      bv({ bookingId: "past", eventDate: "2026-10-01", grandTotal: 5000 }), // past → excluded
      bv({ bookingId: "soon", eventDate: "2026-10-20", grandTotal: 5000 }), // 14d → kept
      bv({ bookingId: "far", eventDate: "2027-01-01", grandTotal: 5000 }), // > 45d → excluded
      bv({ bookingId: "nodate", eventDate: null, grandTotal: 5000 }), // no date → excluded
    ];
    const out = scoreLostQuotes(rows, today, 45);
    expect(out.map((o) => o.id)).toEqual(["soon"]);
    expect(out[0].daysToEvent).toBe(14);
  });

  it("ranks nearer + higher-value events first; unknown value never fabricated", () => {
    const rows = [
      bv({ bookingId: "near-big", eventDate: "2026-10-10", grandTotal: 9000 }), // 4d, big
      bv({ bookingId: "far-big", eventDate: "2026-11-15", grandTotal: 9000 }), // 40d, big
      bv({ bookingId: "near-unknown", eventDate: "2026-10-09", grandTotal: null }), // 3d, no value
    ];
    const out = scoreLostQuotes(rows, today, 45);
    expect(out[0].id).toBe("near-big"); // closest + valuable ranks top
    const unknown = out.find((o) => o.id === "near-unknown")!;
    expect(unknown.value).toBeNull(); // honest: no fabricated value
    expect(unknown.score).toBeGreaterThan(0); // still scored on proximity alone
  });

  it("returns an empty list when nothing is recoverable", () => {
    expect(scoreLostQuotes([], today, 45)).toEqual([]);
    expect(scoreLostQuotes([bv({ eventDate: "2026-01-01", grandTotal: 1000 })], today, 45)).toEqual([]);
  });
});
