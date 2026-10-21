// OpenPhone ("Quo") webhook route — Part B: it now also captures OUTBOUND rep texts (message.delivered /
// message.sent, direction "outgoing"), matched to the lead by the CUSTOMER number, idempotent on the
// provider message id. The existing inbound-message path must keep working unchanged. No signing key is
// configured in the test env (getProviderConfig is empty + OPENPHONE_WEBHOOK_SECRET unset), so the route
// fail-opens exactly as it does during setup — no HMAC needed here.

import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { saveBookings, getCommsForLead } from "@/lib/db/repo";
import { POST } from "./route";

function post(payload: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/openphone/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  ) as unknown as Promise<Response>;
}

function seedLead(): void {
  saveBookings([
    { bookingId: "LEAD1", eventName: "Garcia Wedding", eventDate: "2099-06-01", statusLabel: "Quote Sent", signed: false, grandTotal: 9000, clientName: "Pat Garcia", clientEmail: "pat@example.com", clientPhone: "+13015551234" },
  ]);
}

beforeEach(() => {
  getDb().prepare("DELETE FROM bookings").run();
  getDb().prepare("DELETE FROM comms_events").run();
  delete process.env.OPENPHONE_WEBHOOK_SECRET;
});

describe("POST /api/openphone/webhook — outbound rep SMS capture (Part B)", () => {
  it("records an outbound message.delivered as an outbound comms row matched to the lead by the customer number", async () => {
    seedLead();
    const res = await post({
      type: "message.delivered",
      data: { object: { id: "OP-msg-1", direction: "outgoing", from: "+13019999999", to: ["+13015551234"], body: "Hi Pat, following up on your quote." } },
    });
    expect(res.status).toBe(200);
    const rows = getCommsForLead("LEAD1");
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe("outbound");
    expect(rows[0].channel).toBe("sms");
    expect(rows[0].body).toBe("Hi Pat, following up on your quote.");
    expect(rows[0].toPhone).toBe("+13015551234");
    expect(rows[0].providerId).toBe("OP-msg-1");
  });

  it("also handles message.sent, and the generic direction:outgoing shape", async () => {
    seedLead();
    await post({ type: "message.sent", data: { object: { id: "OP-msg-2", direction: "outgoing", to: ["+13015551234"], body: "first" } } });
    await post({ type: "message.updated", data: { object: { id: "OP-msg-3", direction: "outgoing", to: ["+13015551234"], body: "second" } } });
    expect(getCommsForLead("LEAD1")).toHaveLength(2);
  });

  it("is idempotent on the provider message id — a redelivered webhook does NOT double-log", async () => {
    seedLead();
    const body = { type: "message.delivered", data: { object: { id: "OP-dup", direction: "outgoing", to: ["+13015551234"], body: "once" } } };
    await post(body);
    await post(body);
    expect(getCommsForLead("LEAD1")).toHaveLength(1);
  });

  it("dedupes against an app-originated send that already captured the SAME provider id (no double-count)", async () => {
    seedLead();
    // Simulate the app's own sender having already recorded this exact message (same OpenPhone id).
    const { insertCommsEventIfNew } = await import("@/lib/db/repo");
    insertCommsEventIfNew({ providerId: "OP-app-1", leadId: "LEAD1", direction: "outbound", channel: "sms", toPhone: "+13015551234", body: "app send", actor: "SalesOS", occurredAt: new Date().toISOString() });
    await post({ type: "message.delivered", data: { object: { id: "OP-app-1", direction: "outgoing", to: ["+13015551234"], body: "app send" } } });
    expect(getCommsForLead("LEAD1")).toHaveLength(1); // still one — the webhook de-duped on the id
  });

  it("ignores an outbound message with no customer number (nothing to match / log)", async () => {
    seedLead();
    const res = await post({ type: "message.delivered", data: { object: { id: "OP-no-to", direction: "outgoing", body: "orphan" } } });
    expect(res.status).toBe(200);
    expect(getCommsForLead("LEAD1")).toHaveLength(0);
  });
});

describe("POST /api/openphone/webhook — inbound path unchanged", () => {
  it("still records an inbound message.received as an inbound comms row", async () => {
    seedLead();
    const res = await post({
      type: "message.received",
      data: { object: { id: "OP-in-1", direction: "incoming", from: "+13015551234", to: ["+13019999999"], body: "Yes, interested!" } },
    });
    expect(res.status).toBe(200);
    const rows = getCommsForLead("LEAD1");
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe("inbound");
    expect(rows[0].body).toBe("Yes, interested!");
  });
});
