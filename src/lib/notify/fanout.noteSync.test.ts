import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FanoutCtx } from "./fanout";
import type { Stop } from "@/lib/types";
import { listPendingGsOps } from "@/lib/db/repo";
import { getDb } from "@/lib/db";

// Mock only the external surfaces: the SMS provider (so no real text goes out and we can force a result),
// Slack/ops alerts (no-op), and the Ignition mint (so the link type is deterministic). Everything else —
// template render, tracking-link creation, the messages table, and the gs_outbox note enqueue — runs for
// real against the in-memory DB. `sendSms` returns ok so the "sent" path (and therefore the note) fires.
vi.mock("./sms", async (orig) => ({
  ...(await orig<typeof import("./sms")>()),
  sendSms: vi.fn(async () => ({ ok: true, providerMsgId: "pm-1" })),
}));
vi.mock("./slack", () => ({ slackNotify: vi.fn(async () => ({ ok: true })) }));
vi.mock("./alert", () => ({ alertOps: vi.fn(async () => {}) }));
vi.mock("@/lib/eta/mint", () => ({
  // An Ignition etaLink → the on-the-way note should record "(live map)".
  mintEtaLinkForStop: vi.fn(async () => "https://ignition.zonarsystems.com/etaLink/abc123"),
}));

import { runFanout } from "./fanout";

const stop = (over: Partial<Stop> = {}): Stop => ({
  stopId: "stop-1",
  routeId: "route-1",
  customerId: "cust-1",
  sequence: 1,
  state: "EnRoute",
  custName: "Lebensohn - Wedding",
  custFirstName: "Sarah",
  custLastName: "Lee",
  custPhone: "+13015551212",
  address: "123 Main St",
  txId: "TX-900",
  ...over,
});

const ctx = (over: Partial<FanoutCtx> = {}): FanoutCtx => ({
  action: "LEAVING_WAREHOUSE",
  truckId: "E450",
  baseUrl: "https://app.example.com",
  currentStop: stop(),
  nextStop: null,
  ...over,
});

const notesFor = (txId: string) =>
  listPendingGsOps(200).filter((o) => o.op === "note_append" && o.transactionId === txId);

describe("runFanout → Goodshuffle note sync", () => {
  // The in-memory DB is cleared per FILE, not per test, so wipe the outbox between cases for clean counts.
  beforeEach(() => { process.env.GS_NOTE_SYNC_ENABLED = "true"; getDb().prepare("DELETE FROM gs_outbox").run(); });
  afterEach(() => { delete process.env.GS_NOTE_SYNC_ENABLED; });

  it("on-the-way departure enqueues exactly one note with the project txId and the link type", async () => {
    await runFanout(ctx());
    const ops = notesFor("TX-900");
    expect(ops.length).toBe(1);
    const payload = ops[0].payload as { line: string; dedupeKey: string };
    expect(payload.dedupeKey).toBe("dispatch:stop-1:on_the_way");
    expect(payload.line).toContain("texted Sarah Lee the truck is on the way (live map)");
  });

  it("arrival enqueues its own note, distinct from the on-the-way one", async () => {
    await runFanout(ctx({ action: "ARRIVED" }));
    const ops = notesFor("TX-900");
    expect(ops.length).toBe(1);
    const payload = ops[0].payload as { dedupeKey: string; line: string };
    expect(payload.dedupeKey).toBe("dispatch:stop-1:arrived");
    expect(payload.line).toContain("the truck has arrived");
  });

  it("is idempotent — re-running the same departure does not add a second note", async () => {
    await runFanout(ctx());
    await runFanout(ctx());
    expect(notesFor("TX-900").length).toBe(1);
  });

  it("does NOT enqueue when the gate is off", async () => {
    delete process.env.GS_NOTE_SYNC_ENABLED;
    await runFanout(ctx());
    expect(notesFor("TX-900").length).toBe(0);
  });

  it("does NOT enqueue when the stop has no Goodshuffle txId (manual/old pull)", async () => {
    await runFanout(ctx({ currentStop: stop({ txId: undefined }) }));
    expect(notesFor("TX-900").length).toBe(0);
  });
});
