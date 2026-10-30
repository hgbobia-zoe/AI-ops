import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotCard } from "@/lib/notify/aiBots";

// Reuse the SHARED payroll Slack path, but never actually post during tests — spy on postPayrollCard.
const postPayrollCard = vi.fn(async () => ({ ok: true as const }));
vi.mock("@/lib/payroll/slack", () => ({ postPayrollCard }));

// Period correlation reaches Connecteam/Gusto via payrollReview — stub it so there are NO external calls.
let reviewReady: number | null = null;
let reviewReviewTotal: number | null = null;
vi.mock("@/lib/payroll/review", () => ({
  payrollReview: vi.fn(async (period: { start: string; end: string; label: string }) => ({
    period,
    estReadyPayroll: reviewReady,
    estReviewPayroll: reviewReviewTotal,
  })),
}));

import { upsertWireEvent, readWireEvent, type WireEventRecord } from "@/lib/payroll/wireEvent";

type Body = Record<string, unknown>;

async function post(body: Body, headers: Record<string, string> = {}) {
  const { POST } = await import("./route");
  return POST(
    new Request("http://localhost/api/payroll/gusto-wire-received", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

const lastCard = (): BotCard => postPayrollCard.mock.calls[postPayrollCard.mock.calls.length - 1][0] as unknown as BotCard;

function seedWire(over: Partial<WireEventRecord>): WireEventRecord {
  const rec: WireEventRecord = {
    transactionId: "tx_seed",
    amount: null, amountAbs: null, counterpartyName: "ZenPayroll", bankDescription: null, kind: null,
    status: "sent", createdAt: null, estimatedDeliveryDate: null, dashboardLink: null,
    matchedPeriod: null, postedToSlack: true, postedAt: null, failureNotified: false,
    statusHistory: ["sent"], firstSeenAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...over,
  };
  upsertWireEvent(rec);
  return rec;
}

describe("POST /api/payroll/gusto-wire-received", () => {
  beforeEach(() => {
    delete process.env.WIRE_WEBHOOK_TOKEN;
    reviewReady = null;
    reviewReviewTotal = null;
  });
  afterEach(() => vi.clearAllMocks());

  it("401s when WIRE_WEBHOOK_TOKEN is set and the header is missing/wrong (fail-closed)", async () => {
    process.env.WIRE_WEBHOOK_TOKEN = "s3cret";
    const body = { text: "received $111.11", date: "2026-10-30", messageId: "m-auth" };
    expect((await post(body)).status).toBe(401);
    expect((await post(body, { "x-wire-token": "nope" })).status).toBe(401);
    expect(postPayrollCard).not.toHaveBeenCalled();
    expect((await post(body, { "x-wire-token": "s3cret" })).status).toBe(200);
    expect(postPayrollCard).toHaveBeenCalledTimes(1);
  });

  it("is open until WIRE_WEBHOOK_TOKEN is set (fail-open), parsing the amount from the body", async () => {
    const r = await post({ text: "We received your wire transfer of $222.22 on Friday", messageId: "m-open" });
    const j = (await r.json()) as { posted: boolean };
    expect(r.status).toBe(200);
    expect(j.posted).toBe(true);
    expect(lastCard().title).toBe("Gusto confirmed the payroll wire");
  });

  it("ignores a body with neither an amount nor a message id, posting nothing", async () => {
    const r = await post({ text: "hello with no money and no id" });
    const j = (await r.json()) as { ignored: boolean };
    expect(r.status).toBe(200);
    expect(j.ignored).toBe(true);
    expect(postPayrollCard).not.toHaveBeenCalled();
  });

  it("posts ONCE and is idempotent across re-deliveries of the same receipt", async () => {
    const body = { text: "received $333.33", date: "2026-10-30", messageId: "m-idem" };
    const first = await post(body);
    expect((await first.json()).posted).toBe(true);
    expect(postPayrollCard).toHaveBeenCalledTimes(1);

    const second = await post(body); // Gmail/Zapier re-delivery, same message id
    const j2 = (await second.json()) as { posted: boolean; duplicate: boolean };
    expect(j2.posted).toBe(false);
    expect(j2.duplicate).toBe(true);
    expect(postPayrollCard).toHaveBeenCalledTimes(1); // still once
  });

  it("correlates the receipt to a payroll period when the amount matches the estimate", async () => {
    reviewReady = 444.44; // matches the receipt amount
    const r = await post({ text: "received $444.44", date: "2026-10-30", messageId: "m-period" });
    const j = (await r.json()) as { matchedPeriod: { expectedTotal: number } | null };
    expect(j.matchedPeriod).not.toBeNull();
    expect(j.matchedPeriod!.expectedTotal).toBe(444.44);
    expect(lastCard().body).toContain("pay period");
  });

  it("matches a wire we already sent and marks it confirmed-received", async () => {
    seedWire({
      transactionId: "tx_match_receipt",
      amountAbs: 2158.58,
      matchedPeriod: { periodStart: "2026-10-19", periodEnd: "2026-10-25", periodLabel: "Oct 19 – Oct 25", expectedTotal: 2158.58, source: "x", deltaPct: 0 },
    });
    const r = await post({ text: "received $2,158.58", date: "2026-10-30", messageId: "m-match" });
    const j = (await r.json()) as { posted: boolean; matchedTransactionId: string | null };
    expect(j.posted).toBe(true);
    expect(j.matchedTransactionId).toBe("tx_match_receipt");
    expect(readWireEvent("tx_match_receipt")!.receiptConfirmed).toBe(true);
    // Period carried from the matched wire. The label lives on the (un-humanized) field; the body only
    // references "pay period" because humanize() strips the en-dash inside the label.
    expect((lastCard().fields ?? []).find((f) => f.label === "Pay period")?.value).toBe("Oct 19 – Oct 25");
    expect(lastCard().body).toContain("pay period");
  });

  it("the posted confirmation carries no dashes or emoji (house style)", async () => {
    await post({ text: "received $555.55", date: "2026-10-30", messageId: "m-style" });
    const body = lastCard().body!;
    expect(body).not.toMatch(/[—–]|\s-\s/);
    expect(body).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u);
  });
});
