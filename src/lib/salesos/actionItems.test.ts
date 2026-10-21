import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the outward edges so the scan is DB-driven and deterministic:
//  • the LLM (chat/llmConfigured) — the interpretation step, controlled per test;
//  • the on-demand sync (ensureLeadThreadSynced) — a no-op here (we seed comms_events directly);
//  • the Slack surface (notify) — spied to assert the deduped alert.
vi.mock("@/lib/llm", () => ({ chat: vi.fn(), llmConfigured: vi.fn(() => true) }));
vi.mock("@/lib/comms/openphoneSync", () => ({ ensureLeadThreadSynced: vi.fn(async () => ({ inserted: 0 })) }));
vi.mock("@/lib/comms/openphone", () => ({ openphoneApiKey: vi.fn(() => "op-key") }));
vi.mock("@/lib/notify/channels", () => ({ notify: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/notify/slack", () => ({ slackBotConfigured: () => true, slackConfigured: () => true }));

import { chat, llmConfigured } from "@/lib/llm";
import { notify } from "@/lib/notify/channels";
import {
  normalizeForMatch,
  itemId,
  keepGroundedItems,
  mergeItems,
  applyResolution,
  decideAlert,
  decideThrottle,
  extractActionItems,
  gatherCustomerContext,
  scanLeadActionItems,
  getOpenActionItems,
  getLeadActionItems,
  type ActionItem,
  type StoredActionItem,
  type CustomerContext,
} from "./actionItems";
import { saveBookings, insertCommsEventIfNew, getCommsForLead } from "@/lib/db/repo";

const mockChat = vi.mocked(chat);
const mockLlmConfigured = vi.mocked(llmConfigured);
const mockNotify = vi.mocked(notify);

const chatJson = (obj: unknown) => mockChat.mockResolvedValue({ ok: true, text: JSON.stringify(obj) });

beforeEach(() => {
  mockChat.mockReset();
  mockLlmConfigured.mockReset();
  mockLlmConfigured.mockReturnValue(true);
  mockNotify.mockReset();
  mockNotify.mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof notify>>);
});

// ── Pure helpers ───────────────────────────────────────────────────────────────

describe("pure helpers", () => {
  it("normalizeForMatch is quote/whitespace-insensitive and itemId is stable", () => {
    expect(normalizeForMatch('  “Strike   paragraph 24” ')).toBe("strike paragraph 24");
    expect(itemId("contract_change", "Strike paragraph 24")).toBe(itemId("contract_change", "  strike   paragraph 24  "));
  });

  it("keepGroundedItems keeps only items whose quote appears in the customer text, never fabricates", () => {
    const customer = "Can you strike paragraph 24 of the T&C? Also what's the difference between a 500 vs 300 lb block?";
    const extracted: ActionItem[] = [
      { summary: "Remove paragraph 24", kind: "contract_change", verbatimQuote: "strike paragraph 24 of the T&C" },
      { summary: "Block weight question", kind: "product_question", verbatimQuote: "difference between a 500 vs 300 lb block" },
      { summary: "Invented ask", kind: "pricing_question", verbatimQuote: "please add a 20% discount" }, // not said → drop
      { summary: "", kind: "other", verbatimQuote: "strike paragraph 24" }, // no summary → drop
    ];
    const kept = keepGroundedItems(extracted, customer);
    expect(kept).toHaveLength(2);
    expect(kept.map((k) => k.kind).sort()).toEqual(["contract_change", "product_question"]);
    expect(kept.find((k) => k.kind === "contract_change")!.verbatimQuote).toBe("strike paragraph 24 of the T&C");
  });

  it("mergeItems adds new as open and preserves an existing item's lifecycle", () => {
    const stored: StoredActionItem[] = [
      { id: itemId("objection", "too expensive"), summary: "Price objection", kind: "objection", verbatimQuote: "too expensive", openedAt: "2027-01-01T00:00:00.000Z", raisedAt: "2027-01-01T00:00:00.000Z", resolvedAt: null },
    ];
    const extracted: ActionItem[] = [
      { summary: "Price objection reworded", kind: "objection", verbatimQuote: "too expensive" },
      { summary: "New scheduling ask", kind: "scheduling", verbatimQuote: "move it to Saturday" },
    ];
    const merged = mergeItems(stored, extracted, "2027-02-02T00:00:00.000Z", "2027-02-02T00:00:00.000Z");
    expect(merged).toHaveLength(2);
    const obj = merged.find((m) => m.kind === "objection")!;
    expect(obj.openedAt).toBe("2027-01-01T00:00:00.000Z"); // preserved
    expect(obj.summary).toBe("Price objection reworded"); // refreshed text
    const sched = merged.find((m) => m.kind === "scheduling")!;
    expect(sched.openedAt).toBe("2027-02-02T00:00:00.000Z");
    expect(sched.resolvedAt).toBeNull();
  });

  it("applyResolution clears an open item only on a later outbound, else leaves it open", () => {
    const items: StoredActionItem[] = [
      { id: "a", summary: "ask A", kind: "other", verbatimQuote: "a", openedAt: "x", raisedAt: "2027-03-01T00:00:00.000Z", resolvedAt: null },
      { id: "b", summary: "ask B (no raisedAt)", kind: "other", verbatimQuote: "b", openedAt: "x", raisedAt: null, resolvedAt: null },
    ];
    const after = applyResolution(items, "2027-03-02T00:00:00.000Z", "2027-03-05T00:00:00.000Z");
    expect(after.resolved).toBe(1);
    expect(after.items.find((i) => i.id === "a")!.resolvedAt).toBe("2027-03-05T00:00:00.000Z");
    expect(after.items.find((i) => i.id === "b")!.resolvedAt).toBeNull(); // no ordering proof → stays open

    const noOutbound = applyResolution(items, null, "2027-03-05T00:00:00.000Z");
    expect(noOutbound.resolved).toBe(0);
  });

  it("decideAlert fires once, dedupes an unchanged set within the cool-off, re-fires on change", () => {
    const t0 = Date.parse("2027-04-01T00:00:00.000Z");
    const first = decideAlert(undefined, ["a", "b"], t0);
    expect(first.alert).toBe(true);
    const again = decideAlert(first.next, ["b", "a"], t0 + 60_000); // same set, within cool-off
    expect(again.alert).toBe(false);
    const changed = decideAlert(first.next, ["a", "b", "c"], t0 + 60_000); // new ask
    expect(changed.alert).toBe(true);
    expect(decideAlert(first.next, [], t0 + 60_000).alert).toBe(false); // nothing open
  });

  it("decideThrottle respects the min interval", () => {
    const now = Date.parse("2027-05-01T12:00:00.000Z");
    expect(decideThrottle(undefined, now, 3_600_000)).toBe(true);
    expect(decideThrottle("2027-05-01T11:59:00.000Z", now, 3_600_000)).toBe(false);
    expect(decideThrottle("2027-05-01T10:00:00.000Z", now, 3_600_000)).toBe(true);
  });
});

// ── Extraction (the LLM step, mocked) ────────────────────────────────────────────

describe("extractActionItems", () => {
  const ctx: CustomerContext = {
    transcript: "Customer: Can you strike paragraph 24 of the T&C? And what's the difference between a 500 vs 300 lb block?",
    customerInboundText: "Can you strike paragraph 24 of the T&C? And what's the difference between a 500 vs 300 lb block?",
    inboundCount: 1,
    latestInboundAt: "2027-06-01T00:00:00.000Z",
  };

  it("extracts the two real asks with the customer's verbatim quotes", async () => {
    chatJson({
      items: [
        { summary: "Remove paragraph 24 from the T&C", kind: "contract_change", verbatimQuote: "strike paragraph 24 of the T&C" },
        { summary: "Explain the 500 vs 300 lb block", kind: "product_question", verbatimQuote: "difference between a 500 vs 300 lb block" },
      ],
    });
    const items = await extractActionItems(ctx);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.kind).sort()).toEqual(["contract_change", "product_question"]);
    expect(items.find((i) => i.kind === "contract_change")!.verbatimQuote).toBe("strike paragraph 24 of the T&C");
  });

  it("a plain 'thanks' yields no items", async () => {
    const thanks: CustomerContext = { transcript: "Customer: thanks!", customerInboundText: "thanks!", inboundCount: 1, latestInboundAt: "x" };
    chatJson({ items: [] });
    expect(await extractActionItems(thanks)).toEqual([]);
  });

  it("never fabricates — an item whose quote the customer never said is dropped", async () => {
    chatJson({ items: [{ summary: "Add a discount", kind: "pricing_question", verbatimQuote: "give me 20 percent off" }] });
    expect(await extractActionItems(ctx)).toEqual([]);
  });

  it("no-ops when the LLM is not configured or there is no inbound", async () => {
    mockLlmConfigured.mockReturnValue(false);
    expect(await extractActionItems(ctx)).toEqual([]);
    expect(mockChat).not.toHaveBeenCalled();

    mockLlmConfigured.mockReturnValue(true);
    const empty: CustomerContext = { transcript: "", customerInboundText: "", inboundCount: 0, latestInboundAt: null };
    expect(await extractActionItems(empty)).toEqual([]);
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("tolerates a model that wraps JSON in prose/fences, and never throws on a bad reply", async () => {
    mockChat.mockResolvedValue({ ok: true, text: 'Here you go:\n```json\n{"items":[{"summary":"Move the date","kind":"scheduling","verbatimQuote":"strike paragraph 24 of the T&C"}]}\n```' });
    const items = await extractActionItems(ctx);
    expect(items).toHaveLength(1);
    mockChat.mockResolvedValue({ ok: true, text: "not json at all" });
    expect(await extractActionItems(ctx)).toEqual([]);
    mockChat.mockResolvedValue({ ok: false, error: "boom" });
    expect(await extractActionItems(ctx)).toEqual([]);
  });
});

// ── Gather + scan (DB-driven) ────────────────────────────────────────────────────

function seedLead(id: string, phone = "+12023066780") {
  saveBookings([{ bookingId: id, eventName: "Holly wedding", clientName: "Holly Chang", clientPhone: phone, eventDate: "2099-09-09", signed: false }]);
}
function inbound(id: string, lead: string, body: string, at: string) {
  insertCommsEventIfNew({ providerId: id, leadId: lead, direction: "inbound", channel: "sms", body, actor: "Customer", occurredAt: at });
}

describe("gatherCustomerContext", () => {
  it("builds a two-way transcript and counts only customer inbound", () => {
    const id = "GATHER-1";
    seedLead(id);
    inbound("g-in-1", id, "Can you strike paragraph 24 of the T&C?", "2027-07-01T10:00:00.000Z");
    insertCommsEventIfNew({ providerId: "g-out-1", leadId: id, direction: "outbound", channel: "sms", body: "Sure, looking now", actor: "Zoe", occurredAt: "2027-07-01T11:00:00.000Z" });
    const ctx = gatherCustomerContext(id);
    expect(ctx.inboundCount).toBe(1);
    expect(ctx.customerInboundText).toContain("strike paragraph 24");
    expect(ctx.transcript).toContain("Customer:");
    expect(ctx.transcript).toContain("Zoe:");
    expect(ctx.latestInboundAt).toBe("2027-07-01T10:00:00.000Z");
  });
});

describe("scanLeadActionItems", () => {
  it("detects open asks, surfaces ONE deduped Slack alert, persists them, and sends NO reply", async () => {
    const id = "SCAN-1";
    seedLead(id);
    inbound("s-in-1", id, "Can you strike paragraph 24 of the T&C? And the difference between a 500 vs 300 lb block?", "2027-08-01T10:00:00.000Z");
    chatJson({
      items: [
        { summary: "Remove paragraph 24", kind: "contract_change", verbatimQuote: "strike paragraph 24 of the T&C" },
        { summary: "500 vs 300 lb block", kind: "product_question", verbatimQuote: "difference between a 500 vs 300 lb block" },
      ],
    });

    const outboundBefore = getCommsForLead(id, 50).filter((c) => c.direction === "outbound").length;

    const r1 = await scanLeadActionItems(id, { now: Date.parse("2027-08-01T12:00:00.000Z") });
    expect(r1.ok).toBe(true);
    expect(r1.open).toBe(2);
    expect(r1.alerted).toBe(true);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith("sales", expect.anything()); // routed to the sales domain
    expect(getOpenActionItems(id)).toHaveLength(2);

    // NO auto-reply: the detector must never create an outbound message (no text/email sent).
    const outboundAfter = getCommsForLead(id, 50).filter((c) => c.direction === "outbound").length;
    expect(outboundAfter).toBe(outboundBefore);

    // Second scan, inbound unchanged → the LLM is NOT re-called and the alert is deduped (not re-posted).
    mockChat.mockClear();
    mockNotify.mockClear();
    const r2 = await scanLeadActionItems(id, { now: Date.parse("2027-08-01T12:30:00.000Z") });
    expect(mockChat).not.toHaveBeenCalled(); // unchanged thread → no token spend
    expect(r2.alerted).toBe(false); // deduped within the cool-off
    expect(mockNotify).not.toHaveBeenCalled();
    expect(getOpenActionItems(id)).toHaveLength(2);
  });

  it("resolves open items once a later outbound reply lands (real signal), leaving none open", async () => {
    const id = "SCAN-2";
    seedLead(id);
    inbound("r-in-1", id, "Can you strike paragraph 24 of the T&C?", "2027-09-01T10:00:00.000Z");
    chatJson({ items: [{ summary: "Remove paragraph 24", kind: "contract_change", verbatimQuote: "strike paragraph 24 of the T&C" }] });
    await scanLeadActionItems(id, { now: Date.parse("2027-09-01T11:00:00.000Z") });
    expect(getOpenActionItems(id)).toHaveLength(1);

    // A rep replies after the ask → the deterministic resolution signal clears it on the next scan.
    insertCommsEventIfNew({ providerId: "r-out-1", leadId: id, direction: "outbound", channel: "sms", body: "Done, paragraph 24 removed", actor: "Zoe", occurredAt: "2027-09-02T09:00:00.000Z" });
    const r = await scanLeadActionItems(id, { now: Date.parse("2027-09-02T10:00:00.000Z") });
    expect(r.resolved).toBeGreaterThanOrEqual(1);
    expect(getOpenActionItems(id)).toHaveLength(0);
    expect(getLeadActionItems(id)).toHaveLength(1); // still recorded, just resolved (honest history)
  });

  it("a plain 'thanks' lead surfaces nothing", async () => {
    const id = "SCAN-3";
    seedLead(id);
    inbound("t-in-1", id, "thanks so much!", "2027-10-01T10:00:00.000Z");
    chatJson({ items: [] });
    const r = await scanLeadActionItems(id, { now: Date.parse("2027-10-01T11:00:00.000Z") });
    expect(r.open).toBe(0);
    expect(r.alerted).toBe(false);
    expect(mockNotify).not.toHaveBeenCalled();
  });
});
