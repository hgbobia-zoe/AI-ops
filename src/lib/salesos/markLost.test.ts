import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { getDb } from "@/lib/db";
import { saveBookings, listPendingGsOps, ackGsOp } from "@/lib/db/repo";
import { buildOfficePullScript } from "@/lib/gsPull";
import { KNOWN_DRAINABLE_OPS } from "@/lib/aiorg/outboxHealth";
import { queueMarkLost } from "./markLost";

const base = { eventDate: "2099-06-04", grandTotal: 1800, clientEmail: "x@example.com", clientPhone: "+13015550100" };

beforeEach(() => {
  getDb().prepare("DELETE FROM gs_outbox").run();
  getDb().prepare("DELETE FROM bookings").run();
  saveBookings([
    { ...base, bookingId: "OPEN1", eventName: "Open Quote", statusLabel: "Quote Sent", signed: false, clientName: "A" },
    { ...base, bookingId: "SIGNED1", eventName: "Signed", statusLabel: "Contract Signed", signed: true, clientName: "B" },
    { ...base, bookingId: "LOST1", eventName: "Lost", statusLabel: "Lost", signed: false, clientName: "C" },
  ]);
});

describe("queueMarkLost", () => {
  it("queues one mark_lost op (archive on) for an unsigned open quote, once", () => {
    const r = queueMarkLost("OPEN1", "The event is in 3 days and the quote is not signed.");
    expect(r.queued).toBe(true);
    const ops = listPendingGsOps().filter((o) => o.op === "mark_lost");
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ transactionId: "OPEN1", payload: { archive: true, by: "Sales Bot" } });
    expect(queueMarkLost("OPEN1", "again")).toEqual({ queued: false, reason: "already_queued" });
    ackGsOp(ops[0].id, true); // done stays done: never queued again
    expect(queueMarkLost("OPEN1", "again")).toEqual({ queued: false, reason: "already_queued" });
  });

  it("never touches a signed, already lost, or unknown project", () => {
    expect(queueMarkLost("SIGNED1", "x")).toEqual({ queued: false, reason: "signed" });
    expect(queueMarkLost("LOST1", "x")).toEqual({ queued: false, reason: "already_lost" });
    expect(queueMarkLost("NOPE", "x")).toEqual({ queued: false, reason: "unknown_project" });
    expect(listPendingGsOps()).toHaveLength(0);
  });

  it("both drainers handle mark_lost with the captured endpoints, and the outbox health knows it", () => {
    expect(KNOWN_DRAINABLE_OPS.has("mark_lost")).toBe(true);
    for (const src of [readFileSync("extension/pull-injected.js", "utf8"), buildOfficePullScript("https://zoe-dispatch.fly.dev")]) {
      expect(src).toMatch(/o\.op\s*===\s*"mark_lost"/);
      expect(src).toContain("/app/vendorTransaction/markAsLost");
      expect(src).toContain("/app/vendorTransaction/archiveProject");
    }
  });
});
