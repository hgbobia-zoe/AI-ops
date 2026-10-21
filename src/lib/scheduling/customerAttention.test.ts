import { describe, it, expect, vi, beforeEach } from "vitest";
import { customerAttentionNote, gatherCustomerFacts } from "./customerAttention";
import { renderPacketTouch } from "./commsTemplates";
import { chat, llmConfigured } from "@/lib/llm";
import { getBookingById, getEmailEventsForLead, type BookingView, type EmailEventView } from "@/lib/db/repo";
import type { ShiftPacket } from "./packet";

vi.mock("@/lib/llm", () => ({ chat: vi.fn(), llmConfigured: vi.fn() }));
vi.mock("@/lib/db/repo", () => ({ getBookingById: vi.fn(), getEmailEventsForLead: vi.fn() }));

const mockChat = vi.mocked(chat);
const mockConfigured = vi.mocked(llmConfigured);
const mockBooking = vi.mocked(getBookingById);
const mockEmails = vi.mocked(getEmailEventsForLead);

// A booking with only the fields the gather reads; everything else is irrelevant here.
function booking(over: { internalNotes?: string | null; clientNotes?: string | null; clientName?: string }): BookingView {
  return { internalNotes: null, clientNotes: null, clientName: "", ...over } as unknown as BookingView;
}

function email(over: Partial<EmailEventView>): EmailEventView {
  return { id: "e", providerMsgId: "m", bookingId: "T1", direction: null, participant: null, subject: null, snippet: null, occurredAt: null, openedAt: null, ts: "x", ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfigured.mockReturnValue(true);
  mockEmails.mockReturnValue([]);
  mockBooking.mockReturnValue(null);
});

const ROUTE = (stops: { txId?: string | null; custName?: string | null }[]) => ({ stops });

describe("gatherCustomerFacts (deterministic, facts-only)", () => {
  it("collects internal + client notes and the email thread, deduped by tx_id", () => {
    mockBooking.mockImplementation((id) =>
      id === "T1" ? booking({ internalNotes: "Had delays last time, be punctual.", clientNotes: "Gate code 1234." }) : null,
    );
    mockEmails.mockImplementation((id) =>
      id === "T1" ? [email({ direction: "inbound", participant: "Pat", subject: "Timing", snippet: "Can you come earlier?" })] : [],
    );
    const facts = gatherCustomerFacts([
      { txId: "T1", custName: "Acme Co" },
      { txId: "T1", custName: "Acme Co" }, // duplicate tx → folded
      { txId: null, custName: "No tx" }, // no tx → skipped
    ]);
    expect(facts).toHaveLength(1);
    expect(facts[0].customer).toBe("Acme Co");
    const blob = facts[0].signals.join("\n");
    expect(blob).toContain("Had delays last time");
    expect(blob).toContain("Gate code 1234");
    expect(blob).toContain("Can you come earlier?");
  });

  it("skips customers with no signal at all", () => {
    mockBooking.mockReturnValue(null);
    mockEmails.mockReturnValue([]);
    expect(gatherCustomerFacts([{ txId: "T9", custName: "Quiet" }])).toHaveLength(0);
  });
});

describe("customerAttentionNote (AI heads-up)", () => {
  const signalRoute = () => {
    mockBooking.mockImplementation((id) => (id === "T1" ? booking({ internalNotes: "Customer had delays last time, be punctual." }) : null));
    return ROUTE([{ txId: "T1", custName: "Acme Co" }]);
  };

  it("returns a clean line on a real signal", async () => {
    mockChat.mockResolvedValue({ ok: true, text: "Acme Co had delays last time, so be on time and reassure them." });
    const line = await customerAttentionNote(signalRoute());
    expect(line).toBe("Acme Co had delays last time, so be on time and reassure them.");
    expect(mockChat).toHaveBeenCalledTimes(1); // one call per route
  });

  it("strips any dash or emoji the model slips in (house style)", async () => {
    mockChat.mockResolvedValue({ ok: true, text: "Acme Co had delays last time — be punctual 🚚" });
    const line = await customerAttentionNote(signalRoute());
    expect(line).toBeDefined();
    expect(line).not.toMatch(/[—–]/);
    expect(line).not.toMatch(/🚚/);
  });

  it("returns undefined on NONE", async () => {
    mockChat.mockResolvedValue({ ok: true, text: "NONE" });
    expect(await customerAttentionNote(signalRoute())).toBeUndefined();
  });

  it("returns undefined on an empty completion", async () => {
    mockChat.mockResolvedValue({ ok: true, text: "   " });
    expect(await customerAttentionNote(signalRoute())).toBeUndefined();
  });

  it("returns undefined (never throws) on an LLM error", async () => {
    mockChat.mockResolvedValue({ ok: false, error: "timeout" });
    expect(await customerAttentionNote(signalRoute())).toBeUndefined();
  });

  it("returns undefined (never throws) when chat rejects", async () => {
    mockChat.mockRejectedValue(new Error("network"));
    expect(await customerAttentionNote(signalRoute())).toBeUndefined();
  });

  it("does not call the LLM when it is not configured", async () => {
    mockConfigured.mockReturnValue(false);
    expect(await customerAttentionNote(signalRoute())).toBeUndefined();
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("does not call the LLM when no stop has any signal", async () => {
    mockBooking.mockReturnValue(null);
    mockEmails.mockReturnValue([]);
    expect(await customerAttentionNote(ROUTE([{ txId: "T1", custName: "Quiet" }]))).toBeUndefined();
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("returns undefined for an empty / missing route", async () => {
    expect(await customerAttentionNote(null)).toBeUndefined();
    expect(await customerAttentionNote(ROUTE([]))).toBeUndefined();
    expect(mockChat).not.toHaveBeenCalled();
  });
});

// The renderer stays PURE + SYNC: the heads-up is passed in as a precomputed string, exactly like {link}.
describe("refresher template renders / drops the customerAttention line", () => {
  const packet: ShiftPacket = {
    shiftId: "S1",
    version: "v",
    identity: { date: "2026-10-23", role: "driver", eventLabel: null },
    reporting: { reportTime: null, reportLocation: null, startTime: null, endTime: null, windowKnown: false, mapUrl: null },
    assignment: { workerKind: "internal", displayName: "Sam", truck: { id: "NPR-1", name: "NPR 1" }, supervisor: null, coworkers: [] },
    operations: { route: { stops: 2, firstStop: "Acme", premiumStops: 0, eventReadinessCustomers: [] }, equipment: [], instructions: null },
    timekeeping: { kind: "internal", system: "connecteam" },
    dispatch: { phone: "301-291-5296" },
  };

  it("renders the line when a heads-up is present", () => {
    const body = renderPacketTouch(packet, "refresher", null, "Acme had delays last time, be punctual.");
    expect(body).toContain("Acme had delays last time, be punctual.");
  });

  it("drops the line when the heads-up is null (no fabricated warning)", () => {
    const body = renderPacketTouch(packet, "refresher", null, null);
    expect(body).not.toContain("delays");
    // The renderer is synchronous: its result is a plain string, not a promise.
    expect(typeof body).toBe("string");
  });
});
