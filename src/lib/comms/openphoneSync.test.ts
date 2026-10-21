import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CommsEventView } from "@/lib/db/repo";

// Mock the OpenPhone API layer: syncLeadTextThread/syncActiveLeadTextThreads are the units under test;
// the live API (getCustomerTextThread) and the key gate (openphoneApiKey) are controlled per test.
vi.mock("./openphone", () => ({
  getCustomerTextThread: vi.fn(),
  openphoneApiKey: vi.fn(),
}));

import { getCustomerTextThread, openphoneApiKey } from "./openphone";
import { syncLeadTextThread, syncActiveLeadTextThreads, ensureLeadThreadSynced } from "./openphoneSync";
import { saveBookings, getCommsForLead } from "@/lib/db/repo";
import { todayInOpsTz } from "@/lib/dates";

const mockThread = vi.mocked(getCustomerTextThread);
const mockKey = vi.mocked(openphoneApiKey);

function msg(partial: Partial<CommsEventView> & { id: string; direction: "inbound" | "outbound" }): CommsEventView {
  return {
    id: partial.id,
    providerId: partial.providerId ?? partial.id,
    leadId: null,
    direction: partial.direction,
    channel: partial.channel ?? "sms",
    fromPhone: partial.fromPhone ?? null,
    toPhone: partial.toPhone ?? null,
    body: partial.body ?? "hello",
    actor: partial.actor ?? (partial.direction === "inbound" ? "Customer" : "Zoe"),
    occurredAt: partial.occurredAt ?? "2027-05-01T10:00:00.000Z",
    ts: partial.occurredAt ?? "2027-05-01T10:00:00.000Z",
  };
}

beforeEach(() => {
  mockThread.mockReset();
  mockKey.mockReset();
  mockKey.mockReturnValue("op-key"); // configured by default
});

describe("syncLeadTextThread", () => {
  it("upserts outbound + inbound messages matched to the lead", async () => {
    const id = "OPS-lead-1";
    mockThread.mockResolvedValue([
      msg({ id: "m-out-1", direction: "outbound", body: "Following up on your quote", occurredAt: "2027-05-02T10:00:00.000Z" }),
      msg({ id: "m-in-1", direction: "inbound", body: "Sounds good!", occurredAt: "2027-05-03T10:00:00.000Z" }),
    ]);

    const r = await syncLeadTextThread(id, "301-555-7777");
    expect(r.inserted).toBe(2);

    const stored = getCommsForLead(id, 50);
    expect(stored).toHaveLength(2);
    expect(stored.every((c) => c.leadId === id && c.channel === "sms")).toBe(true);
    expect(stored.map((c) => c.direction).sort()).toEqual(["inbound", "outbound"]);
    // Facts preserved: body + the OpenPhone message id as the idempotency key.
    const out = stored.find((c) => c.direction === "outbound")!;
    expect(out.providerId).toBe("m-out-1");
    expect(out.body).toBe("Following up on your quote");
  });

  it("is idempotent on re-run — no duplicate rows (dedupes on the OpenPhone message id)", async () => {
    const id = "OPS-lead-2";
    const thread = [
      msg({ id: "dup-out", direction: "outbound", body: "hi" }),
      msg({ id: "dup-in", direction: "inbound", body: "hey" }),
    ];
    mockThread.mockResolvedValue(thread);

    const first = await syncLeadTextThread(id, "2025550000");
    expect(first.inserted).toBe(2);
    const second = await syncLeadTextThread(id, "2025550000");
    expect(second.inserted).toBe(0); // all already stored → no-op
    expect(getCommsForLead(id, 50)).toHaveLength(2);
  });

  it("skips messages with no body or no provider id (facts only)", async () => {
    const id = "OPS-lead-3";
    mockThread.mockResolvedValue([
      msg({ id: "ok-1", direction: "inbound", body: "real text" }),
      msg({ id: "", direction: "inbound", providerId: "", body: "no id" }),
      msg({ id: "empty-body", direction: "outbound", body: "" }),
    ]);
    const r = await syncLeadTextThread(id, "3015551212");
    expect(r.inserted).toBe(1);
    expect(getCommsForLead(id, 50)).toHaveLength(1);
  });

  it("no-ops with no phone, and never throws when the API layer rejects", async () => {
    const empty = await syncLeadTextThread("OPS-lead-4", null);
    expect(empty.inserted).toBe(0);
    expect(mockThread).not.toHaveBeenCalled(); // short-circuits before the API

    mockThread.mockRejectedValue(new Error("boom"));
    const r = await syncLeadTextThread("OPS-lead-4", "3015559999");
    expect(r.inserted).toBe(0); // swallowed
  });
});

describe("Holly's thread lands in comms_events", () => {
  it("backfills her full two-way thread, attached to her lead, idempotent on re-run", async () => {
    // The exact failure the fix targets: Holly's lead (231885765, +12023066780) had the full OpenPhone
    // thread but almost none of it in comms_events. After the sync runs, her thread is present + attached.
    const id = "231885765";
    mockThread.mockResolvedValue([
      msg({ id: "holly-out-1", direction: "outbound", body: "I sent the agreement over, let me know if you have questions", occurredAt: "2027-05-01T14:00:00.000Z" }),
      msg({ id: "holly-in-1", direction: "inbound", body: "I was already helped by Jessie, thank you", occurredAt: "2027-05-01T15:00:00.000Z" }),
    ]);
    const r = await syncLeadTextThread(id, "+12023066780");
    expect(r.inserted).toBe(2);

    const stored = getCommsForLead(id, 50);
    expect(stored).toHaveLength(2);
    expect(stored.every((c) => c.leadId === id)).toBe(true);
    expect(stored.map((c) => c.direction).sort()).toEqual(["inbound", "outbound"]);
    expect(stored.some((c) => (c.body ?? "").includes("sent the agreement"))).toBe(true);
    expect(stored.some((c) => (c.body ?? "").includes("already helped by Jessie"))).toBe(true);

    // Re-running (the periodic job + the on-demand wrapper both hit the same thread) never double-counts.
    const again = await syncLeadTextThread(id, "+12023066780");
    expect(again.inserted).toBe(0);
    expect(getCommsForLead(id, 50)).toHaveLength(2);
  });
});

describe("ensureLeadThreadSynced", () => {
  it("syncs on demand when configured, and is a no-op (no API call) when the key is unset", async () => {
    const id = "ENSURE-1";
    mockThread.mockResolvedValue([msg({ id: "e-in-1", direction: "inbound", body: "quick question" })]);
    const r = await ensureLeadThreadSynced(id, "2025551234");
    expect(r.inserted).toBe(1);
    expect(getCommsForLead(id, 50)).toHaveLength(1);

    mockKey.mockReturnValue(null); // unconfigured
    mockThread.mockClear();
    const noop = await ensureLeadThreadSynced("ENSURE-2", "2025559999");
    expect(noop.inserted).toBe(0);
    expect(mockThread).not.toHaveBeenCalled(); // key gate short-circuits before the API
  });

  it("never throws when the API layer rejects", async () => {
    mockThread.mockRejectedValue(new Error("boom"));
    const r = await ensureLeadThreadSynced("ENSURE-3", "2025550000");
    expect(r.inserted).toBe(0);
  });
});

describe("syncActiveLeadTextThreads", () => {
  it("no-ops when the OpenPhone API key is not configured", async () => {
    mockKey.mockReturnValue(null);
    const r = await syncActiveLeadTextThreads();
    expect(r).toEqual({ leads: 0, inserted: 0 });
    expect(mockThread).not.toHaveBeenCalled();
  });

  it("bounds the lead set to the cap and only syncs leads with a phone", async () => {
    const today = todayInOpsTz();
    const future = `${Number(today.slice(0, 4)) + 2}${today.slice(4)}`;
    // 3 leads with phones, 1 without — the no-phone lead is never synced.
    saveBookings([
      { bookingId: "AC-1", eventName: "A", clientName: "A", clientPhone: "3015550001", eventDate: future, signed: false },
      { bookingId: "AC-2", eventName: "B", clientName: "B", clientPhone: "3015550002", eventDate: future, signed: false },
      { bookingId: "AC-3", eventName: "C", clientName: "C", clientPhone: "3015550003", eventDate: future, signed: false },
      { bookingId: "AC-nophone", eventName: "D", clientName: "D", clientPhone: "", eventDate: future, signed: false },
    ]);
    mockThread.mockResolvedValue([msg({ id: "x", direction: "inbound" })]);

    const r = await syncActiveLeadTextThreads({ cap: 2 });
    expect(r.leads).toBe(2); // capped at 2, no-phone excluded
    expect(mockThread).toHaveBeenCalledTimes(2);
  });

  it("tolerates a per-lead failure — one throwing lead never aborts the rest", async () => {
    const today = todayInOpsTz();
    const future = `${Number(today.slice(0, 4)) + 2}${today.slice(4)}`;
    saveBookings([
      { bookingId: "TOL-1", eventName: "A", clientName: "A", clientPhone: "3019991111", eventDate: future, signed: false },
      { bookingId: "TOL-2", eventName: "B", clientName: "B", clientPhone: "3019992222", eventDate: future, signed: false },
    ]);
    // Key the mock on the customer phone so the test is deterministic regardless of other pipeline leads
    // in the shared in-memory DB: TOL-1's thread rejects (syncLeadTextThread swallows it and the run goes
    // on), TOL-2's resolves, everything else returns an empty thread.
    mockThread.mockImplementation(async (phone?: string | null) => {
      if (phone === "3019991111") throw new Error("rate limited");
      if (phone === "3019992222") return [msg({ id: "tol-in", direction: "inbound", body: "hi" })];
      return [];
    });

    const r = await syncActiveLeadTextThreads();
    expect(r.leads).toBeGreaterThanOrEqual(2); // the run completed past the throwing lead
    expect(getCommsForLead("TOL-2", 50)).toHaveLength(1); // the healthy lead after the failure was synced
    expect(getCommsForLead("TOL-1", 50)).toHaveLength(0); // the failing lead stored nothing
  });
});
