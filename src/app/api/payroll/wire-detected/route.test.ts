import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotCard } from "@/lib/notify/aiBots";

// Reuse the SHARED payroll Slack path, but never actually post during tests — spy on postPayrollCard. The
// route imports it from @/lib/payroll/slack, so mocking that module keeps the test free of any real Slack call.
const postPayrollCard = vi.fn(async () => ({ ok: true as const }));
vi.mock("@/lib/payroll/slack", () => ({ postPayrollCard }));

// Period correlation reaches Connecteam/Gusto via payrollReview — stub it so there are NO external calls and
// we can drive the match vs no-match paths. estReadyPayroll/estReviewPayroll are the only fields read.
let reviewReady: number | null = null;
let reviewReviewTotal: number | null = null;
vi.mock("@/lib/payroll/review", () => ({
  payrollReview: vi.fn(async (period: { start: string; end: string; label: string }) => ({
    period,
    estReadyPayroll: reviewReady,
    estReviewPayroll: reviewReviewTotal,
  })),
}));

import { readWireEvent } from "@/lib/payroll/wireEvent";

type Body = Record<string, unknown>;

async function post(body: Body, headers: Record<string, string> = {}) {
  const { POST } = await import("./route");
  return POST(
    new Request("http://localhost/api/payroll/wire-detected", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function gustoWire(over: Body = {}): Body {
  return {
    amount: -5000,
    status: "sent",
    counterpartyName: "ZenPayroll",
    bankDescription: "ZenPayroll payroll wire",
    kind: "wireTransaction",
    createdAt: "2026-10-27T14:00:00.000Z",
    dashboardLink: "https://mercury.com/transactions/abc123",
    transactionId: "tx_abc123",
    ...over,
  };
}

const lastCard = (): BotCard => postPayrollCard.mock.calls[postPayrollCard.mock.calls.length - 1][0] as unknown as BotCard;

describe("POST /api/payroll/wire-detected", () => {
  beforeEach(() => {
    delete process.env.WIRE_WEBHOOK_TOKEN;
    delete process.env.PAYROLL_WIRE_MATCH_PATTERN;
    reviewReady = null;
    reviewReviewTotal = null;
  });
  afterEach(() => vi.clearAllMocks());

  it("401s when WIRE_WEBHOOK_TOKEN is set and the header is missing/wrong (fail-closed)", async () => {
    process.env.WIRE_WEBHOOK_TOKEN = "s3cret";
    expect((await post(gustoWire())).status).toBe(401);
    expect((await post(gustoWire(), { "x-wire-token": "nope" })).status).toBe(401);
    expect(postPayrollCard).not.toHaveBeenCalled();
    const ok = await post(gustoWire(), { "x-wire-token": "s3cret" });
    expect(ok.status).toBe(200);
    expect(postPayrollCard).toHaveBeenCalledTimes(1);
  });

  it("is open until WIRE_WEBHOOK_TOKEN is set (fail-open posture)", async () => {
    const r = await post(gustoWire({ transactionId: "tx_open" }));
    expect(r.status).toBe(200);
    expect((await r.json()).posted).toBe(true);
  });

  it("ignores a non-payroll transaction and posts nothing", async () => {
    const r = await post(gustoWire({ counterpartyName: "Google", bankDescription: "Google Workspace", kind: "debitCardTransaction", transactionId: "tx_google" }));
    const j = (await r.json()) as { ok: boolean; ignored: boolean };
    expect(r.status).toBe(200);
    expect(j.ignored).toBe(true);
    expect(postPayrollCard).not.toHaveBeenCalled();
    expect(readWireEvent("tx_google")).toBeNull(); // not persisted
  });

  it("ignores an INCOMING amount even from ZenPayroll", async () => {
    const r = await post(gustoWire({ amount: 5000, transactionId: "tx_in" }));
    expect((await r.json()).ignored).toBe(true);
    expect(postPayrollCard).not.toHaveBeenCalled();
  });

  it("400s when transactionId is missing", async () => {
    const r = await post(gustoWire({ transactionId: undefined }));
    expect(r.status).toBe(400);
  });

  it("posts ONCE and is idempotent across re-deliveries of the same transactionId", async () => {
    const first = await post(gustoWire({ status: "pending", transactionId: "tx_idem" }));
    expect((await first.json()).posted).toBe(true);
    expect(postPayrollCard).toHaveBeenCalledTimes(1);

    // Mercury re-delivers as pending → sent; Zapier retries. Same transactionId → no second post.
    const second = await post(gustoWire({ status: "sent", transactionId: "tx_idem" }));
    const j2 = (await second.json()) as { posted: boolean; postedToSlack: boolean };
    expect(j2.posted).toBe(false);
    expect(j2.postedToSlack).toBe(true);
    expect(postPayrollCard).toHaveBeenCalledTimes(1); // still once

    const rec = readWireEvent("tx_idem")!;
    expect(rec.status).toBe("sent"); // record updated
    expect(rec.statusHistory).toEqual(["pending", "sent"]);
  });

  it("posts exactly one extra concise update when a known wire later fails", async () => {
    await post(gustoWire({ status: "sent", transactionId: "tx_fail" }));
    expect(postPayrollCard).toHaveBeenCalledTimes(1);

    const failed = await post(gustoWire({ status: "failed", transactionId: "tx_fail" }));
    expect((await failed.json()).posted).toBe(true);
    expect(postPayrollCard).toHaveBeenCalledTimes(2);
    expect(lastCard().title).toBe("Gusto payroll wire failed");

    // A second failed re-delivery does not post again.
    await post(gustoWire({ status: "failed", transactionId: "tx_fail" }));
    expect(postPayrollCard).toHaveBeenCalledTimes(2);
    expect(readWireEvent("tx_fail")!.failureNotified).toBe(true);
  });

  it("correlates the wire to a payroll period when the amount matches the estimate", async () => {
    reviewReady = 5000; // matches |amount|
    const r = await post(gustoWire({ transactionId: "tx_match" }));
    const j = (await r.json()) as { matchedPeriod: { expectedTotal: number } | null };
    expect(j.matchedPeriod).not.toBeNull();
    expect(j.matchedPeriod!.expectedTotal).toBe(5000);
    expect(lastCard().body).toContain("pay period"); // "... for the <period> pay period"
  });

  it("still posts, with the period line omitted (not 'unconfirmed'), when nothing correlates", async () => {
    reviewReady = 999999; // far from the wire → no match
    const r = await post(gustoWire({ transactionId: "tx_nomatch" }));
    const j = (await r.json()) as { posted: boolean; matchedPeriod: unknown };
    expect(j.posted).toBe(true);
    expect(j.matchedPeriod).toBeNull();
    expect(lastCard().body).not.toContain("unconfirmed");
    expect(lastCard().body).not.toContain("pay period");
  });

  it("the posted sent-alert carries no dashes or emoji (house style)", async () => {
    await post(gustoWire({ transactionId: "tx_style" }));
    const body = lastCard().body!;
    expect(body).not.toMatch(/[—–]|\s-\s/);
    expect(body).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u);
  });
});
