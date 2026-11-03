// Outbound calls must not land on the lead timeline as inbound. Quo's summary webhook event carries no
// direction; the ingest now resolves it (stored row, else Quo call details) and the repair fixes old rows.
// Quo and Slack are MOCKED: no network calls.

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

vi.mock("@/lib/comms/openphone", async (orig) => ({
  ...(await orig<typeof import("@/lib/comms/openphone")>()),
  getCallTranscript: vi.fn(async () => null),
  getCallSummary: vi.fn(async () => null),
  getCallDetails: vi.fn(async () => null),
  openphoneUserInitials: vi.fn(async () => "JM"),
}));
vi.mock("@/lib/notify/slack", () => ({ slackNotifyAlert: vi.fn(async () => ({ ok: true })) }));

import { getDb } from "@/lib/db";
import { saveBookings, insertCommsEventIfNew, getCommsForLead, getCallEventByProviderId } from "@/lib/db/repo";
import { getCallDetails } from "@/lib/comms/openphone";
import { ingestCallEvent } from "@/lib/comms/service";
import { repairCallDirections } from "./callDirectionRepair";

const details = getCallDetails as unknown as Mock;
const CLIENT = "+13015550199";

beforeEach(() => {
  details.mockReset();
  details.mockResolvedValue(null);
  for (const t of ["comms_events", "call_events", "bookings", "gs_outbox"]) getDb().prepare(`DELETE FROM ${t}`).run();
  saveBookings([
    { bookingId: "CD1", eventName: "Bancha Party", eventDate: "2099-06-04", statusLabel: "Quote Sent", signed: false, grandTotal: 1871, clientName: "Naomi Bancha", clientEmail: "n@example.com", clientPhone: CLIENT },
  ]);
});

describe("ingestCallEvent direction", () => {
  it("a summary event with no direction uses Quo's call details, so a rep's call stays outbound", async () => {
    details.mockResolvedValue({ direction: "outgoing", participants: [CLIENT], customerPhone: CLIENT });
    await ingestCallEvent({ callId: "AC1", eventType: "call.summary.completed", summary: "Jessie called Naomi to follow up on the quote." });
    const call = getCommsForLead("CD1").find((c) => c.channel === "call");
    expect(call?.direction).toBe("outbound");
    expect(getCallEventByProviderId("AC1")?.direction).toBe("outgoing");
  });

  it("uses the direction an earlier event already stored", async () => {
    await ingestCallEvent({ callId: "AC2", eventType: "call.completed", direction: "outgoing", fromPhone: "+13015559999", toPhone: CLIENT, durationSec: 40 });
    await ingestCallEvent({ callId: "AC2", eventType: "call.summary.completed", summary: "Follow up call about the quote." });
    expect(getCommsForLead("CD1").find((c) => c.channel === "call")?.direction).toBe("outbound");
  });

  it("a client's call is still inbound", async () => {
    await ingestCallEvent({ callId: "AC3", eventType: "call.completed", direction: "incoming", fromPhone: CLIENT, toPhone: "+13015559999", durationSec: 60, summary: "Naomi asked about chairs." });
    expect(getCommsForLead("CD1").find((c) => c.channel === "call")?.direction).toBe("inbound");
  });
});

describe("repairCallDirections", () => {
  const seed = (id: string, at: string) =>
    insertCommsEventIfNew({ providerId: `call:${id}`, leadId: "CD1", direction: "inbound", channel: "call", fromPhone: null, toPhone: null, body: "summary", actor: "J", occurredAt: at });

  it("reports without writing, then fixes only the calls Quo says were outgoing", async () => {
    seed("OUT1", "2026-10-28T18:29:46Z");
    seed("IN1", "2026-10-20T15:00:00Z");
    seed("GONE", "2026-10-10T15:00:00Z");
    details.mockImplementation(async (id: string) => (id === "OUT1" ? { direction: "outgoing" } : id === "IN1" ? { direction: "incoming" } : null));

    const dry = await repairCallDirections({ apply: false, limit: 50 });
    expect(dry).toMatchObject({ checked: 3, outbound: 1, inbound: 1, unknown: 1, fixedLeads: ["CD1"], nextBefore: null });
    expect(getCommsForLead("CD1").filter((c) => c.direction === "inbound")).toHaveLength(3);

    await repairCallDirections({ apply: true, limit: 50 });
    const byId = Object.fromEntries(getCommsForLead("CD1").map((c) => [c.providerId, c.direction]));
    expect(byId).toEqual({ "call:OUT1": "outbound", "call:IN1": "inbound", "call:GONE": "inbound" });
  });

  it("pages with nextBefore", async () => {
    seed("A", "2026-10-28T00:00:00Z");
    seed("B", "2026-10-27T00:00:00Z");
    const first = await repairCallDirections({ apply: false, limit: 1 });
    expect(first.nextBefore).toBe("2026-10-28T00:00:00Z");
    const second = await repairCallDirections({ apply: false, limit: 1, before: first.nextBefore });
    expect(second.checked).toBe(1);
  });
});
