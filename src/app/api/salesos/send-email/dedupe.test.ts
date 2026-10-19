import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep the touchpoint-note side effect inert (it's gated off by default anyway) and the viewer lookup
// hermetic, so this test exercises ONLY the send-email enqueue + its dedupe.
vi.mock("@/lib/auth/getSession", () => ({ viewerInitials: vi.fn(async () => "AB") }));

import { enqueueGsOp, recentEmailSendOpExists, listGsOps, saveBookings } from "@/lib/db/repo";

describe("recentEmailSendOpExists (double-submit guard)", () => {
  it("matches a still-pending email_send with the same dedupeKey, and nothing else", () => {
    enqueueGsOp({ op: "email_send", transactionId: "123", label: "email reply", payload: { content: "<div>hi</div>", dedupeKey: "123:abc" } });
    expect(recentEmailSendOpExists("123:abc")).toBe(true);
    expect(recentEmailSendOpExists("123:different")).toBe(false);
    expect(recentEmailSendOpExists("")).toBe(false);
  });

  it("ignores email_send ops that carry no dedupeKey (e.g. the AI-approval path)", () => {
    enqueueGsOp({ op: "email_send", transactionId: "999", label: "approval email", payload: { content: "<div>x</div>" } });
    expect(recentEmailSendOpExists("999:whatever")).toBe(false);
  });
});

describe("send-email route is idempotent on a double submit (defect #4)", () => {
  beforeEach(() => {
    process.env.EMAIL_SEND_ENABLED = "true";
    saveBookings([
      { bookingId: "L-1", eventName: "Smith Wedding", clientName: "Pat Smith", clientEmail: "pat@example.com" },
      { bookingId: "L-2", eventName: "Jones Gala", clientName: "Jo Jones", clientEmail: "jo@example.com" },
    ]);
  });
  afterEach(() => {
    delete process.env.EMAIL_SEND_ENABLED;
    vi.clearAllMocks();
  });

  async function send(body: Record<string, unknown>) {
    const { POST } = await import("./route");
    return POST(new Request("http://localhost/api/salesos/send-email", { method: "POST", body: JSON.stringify(body) }));
  }

  it("enqueues once, not twice, for the same submitted reply", async () => {
    const payload = { id: "L-1", subject: "Your quote", content: "Thanks for reaching out, here are the details." };

    const r1 = await send(payload);
    const j1 = (await r1.json()) as { ok?: boolean; queued?: boolean; duplicate?: boolean };
    expect(j1.ok).toBe(true);
    expect(j1.duplicate).toBeUndefined();

    const r2 = await send(payload); // double click / retried request, identical body
    const j2 = (await r2.json()) as { ok?: boolean; queued?: boolean; duplicate?: boolean };
    expect(j2.ok).toBe(true);
    expect(j2.duplicate).toBe(true);

    const emailOps = listGsOps(100).filter((o) => o.op === "email_send" && o.transactionId === "L-1");
    expect(emailOps).toHaveLength(1);
  });

  it("allows a genuinely different reply to the same lead", async () => {
    // Own lead (L-2) so the count is isolated from the other test in this file (the DB is cleared
    // per-file, not per-test).
    await send({ id: "L-2", subject: "Your quote", content: "First message." });
    await send({ id: "L-2", subject: "Your quote", content: "A second, different message." });
    const emailOps = listGsOps(100).filter((o) => o.op === "email_send" && o.transactionId === "L-2");
    expect(emailOps).toHaveLength(2);
  });
});
