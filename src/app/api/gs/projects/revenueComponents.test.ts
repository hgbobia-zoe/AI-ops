// Stage 3 revenue-components ingest: the components-only POST path on /api/gs/projects, the cents→dollars
// conversion at ingest, the persist/read round-trip, and the COALESCE no-downgrade guard. Uses the real
// in-memory DB.

import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { getBookingRevenueComponents } from "@/lib/db/repo";
import { buildRevenueModel } from "@/lib/finance/revenueModel";
import { POST } from "./route";

beforeEach(() => {
  getDb().prepare("DELETE FROM booking_revenue_components").run();
});

function req(body: unknown): Request {
  return new Request("http://localhost/api/gs/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// The component shape the pull sends — CENTS, keyed by bookingId.
const CENTS = {
  bookingId: "TX-1",
  quotedSubtotal: 500000,
  contractTotal: 508800,
  grandTotal: 508800,
  productSubtotal: 400000,
  logisticsSubtotal: 50000,
  discount: 15000,
  additionalDiscount: 5000,
  taxableSubtotal: 480000,
  taxTotal: 28800,
  effectiveTaxRate: 0.06,
  collected: 254400,
  refunds: 10000,
  processingFees: 7000,
  goodshuffleFees: 3000,
};

describe("POST /api/gs/projects — revenue components ingest", () => {
  it("a components-only POST persists dollars and does not run the bookings pipeline", async () => {
    const res = await POST(req({ components: [CENTS] }));
    const json = (await res.json()) as { ok: boolean; savedComponents: number; saved: number; pruned: number };
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.savedComponents).toBe(1);
    expect(json.saved).toBe(0); // no projects → no bookings written
    expect(json.pruned).toBe(0);
  });

  it("round-trips CENTS → stored DOLLARS → built model", async () => {
    await POST(req({ components: [CENTS] }));
    const stored = getBookingRevenueComponents("TX-1");
    expect(stored).not.toBeNull();
    expect(stored!.grandTotal).toBe(5088); // ÷100
    expect(stored!.quotedSubtotal).toBe(5000);
    expect(stored!.taxTotal).toBe(288);
    expect(stored!.effectiveTaxRate).toBe(0.06); // rate, NOT divided
    expect(stored!.collected).toBe(2544);
    expect(stored!.refunds).toBe(100);

    const model = buildRevenueModel(stored!, true);
    expect(model.discountsTotal).toBe(200);
    expect(model.feesTotal).toBe(100);
    expect(model.netCollected).toBe(2444);
    expect(model.contractedStatus).toBe("SIGNED");
  });

  it("a later partial re-pull NEVER downgrades a known figure (COALESCE)", async () => {
    await POST(req({ components: [CENTS] }));
    // A transient response that only carried grandTotal (everything else null) must not wipe collected/tax.
    await POST(req({ components: [{ bookingId: "TX-1", grandTotal: 600000 }] }));
    const stored = getBookingRevenueComponents("TX-1");
    expect(stored!.grandTotal).toBe(6000); // updated
    expect(stored!.collected).toBe(2544); // preserved, not nulled
    expect(stored!.taxTotal).toBe(288); // preserved
  });

  it("rejects a POST that carries neither projects[] nor components[]", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
  });

  it("returns null for a project with no components pulled yet (fallback path)", () => {
    expect(getBookingRevenueComponents("NEVER-PULLED")).toBeNull();
  });
});
