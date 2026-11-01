import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep the audit side effect inert (it would otherwise try to resolve a session) and silence the optional
// sales-ai Slack ping. Nothing real is mocked — the DB is the in-memory SQLite the harness provisions.
vi.mock("@/lib/intake/audit", () => ({ logIntakeEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/notify/channels", () => ({ notify: vi.fn(async () => ({ ok: true })) }));

import { listGsOps } from "@/lib/db/repo";
import { listRecentIntakes } from "@/lib/intake/store";
import { notify } from "@/lib/notify/channels";

type LeadBody = Record<string, unknown>;

async function callLead(body: LeadBody, headers: Record<string, string> = {}) {
  const { POST } = await import("./route");
  return POST(
    new Request("http://localhost/api/intake/lead", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

async function callIntakeResult(body: LeadBody) {
  const { POST } = await import("@/app/api/gs/intake-result/route");
  return POST(new Request("http://localhost/api/gs/intake-result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
}

// A valid lead with a per-test email/phone — the in-memory DB persists across tests in this file and the
// 10 minute dedupe window would otherwise make a reused contact a "duplicate", so each test gets its own.
function validLead(over: LeadBody = {}): LeadBody {
  return { source: "web_form", firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: "5555550111", eventType: "wedding", eventDate: "2027-06-20", guestCount: 120, message: "Need tables + chairs", ...over };
}

function createOpsFor(intakeId: string) {
  return listGsOps(200).filter((o) => o.op === "create_project" && (o.payload as { intakeId?: string }).intakeId === intakeId);
}

describe("POST /api/intake/lead", () => {
  beforeEach(() => {
    delete process.env.INTAKE_TOKEN;
    delete process.env.WEB_INTAKE_ENABLED;
    delete process.env.WEB_INTAKE_SALES_PING;
  });
  afterEach(() => vi.clearAllMocks());

  it("400s when neither email nor phone is provided", async () => {
    const r = await callLead({ source: "web_form", firstName: "No", lastName: "Contact", eventType: "wedding" });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("email_or_phone_required");
  });

  it("accepts a phone-only lead (email OR phone is enough)", async () => {
    process.env.WEB_INTAKE_ENABLED = "true";
    const r = await callLead({ source: "yelp", phone: "5555550123", eventType: "corporate" });
    const j = (await r.json()) as { ok: boolean; created: boolean };
    expect(j.ok).toBe(true);
    expect(j.created).toBe(true);
  });

  it("enforces the token gate when INTAKE_TOKEN is set (fail-closed)", async () => {
    process.env.INTAKE_TOKEN = "s3cret";
    const body = validLead({ email: "token@example.com", phone: "5550000001" });
    const bad = await callLead(body, { "x-intake-token": "wrong" });
    expect(bad.status).toBe(401);
    const none = await callLead(body);
    expect(none.status).toBe(401);
    process.env.WEB_INTAKE_ENABLED = "true";
    const ok = await callLead(body, { "x-intake-token": "s3cret" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).ok).toBe(true);
  });

  it("is open until INTAKE_TOKEN is set (fail-open posture)", async () => {
    process.env.WEB_INTAKE_ENABLED = "true";
    const r = await callLead(validLead({ email: "open@example.com", phone: "5550000002" })); // no token header, no env token
    expect(r.status).toBe(200);
    expect((await r.json()).created).toBe(true);
  });

  it("records but does NOT create when the master switch is off (default)", async () => {
    const r = await callLead(validLead({ email: "disabled@example.com", phone: "5550000003" }));
    const j = (await r.json()) as { ok: boolean; created: boolean; reason: string; intakeId: string };
    expect(j.ok).toBe(true);
    expect(j.created).toBe(false);
    expect(j.reason).toBe("intake disabled");
    // Recorded (nothing lost) but no create op.
    expect(listRecentIntakes(50).some((i) => i.id === j.intakeId)).toBe(true);
    expect(createOpsFor(j.intakeId)).toHaveLength(0);
  });

  it("enqueues a create_project op with the mapped fields + source tag when enabled", async () => {
    process.env.WEB_INTAKE_ENABLED = "true";
    const r = await callLead(validLead({ email: "Mapped@Example.com", phone: "(555) 000-0004" }));
    const j = (await r.json()) as { created: boolean; intakeId: string };
    expect(j.created).toBe(true);

    const ops = createOpsFor(j.intakeId);
    expect(ops).toHaveLength(1);
    const p = ops[0].payload as Record<string, unknown>;
    expect(p.eventName).toBe("Smith - Wedding"); // client name + event type convention
    expect(p.kind).toBe("web_lead");
    expect(p.source).toBe("web_form");
    expect(p.leadEmail).toBe("mapped@example.com"); // normalized (lowercased)
    expect(p.leadPhone).toBe("5550000004"); // normalized (digits only)
    expect((p.details as { headCount?: string }).headCount).toBe("120");
    expect((p.details as { fromDateStr?: string }).fromDateStr).toBe("Jun 20 2027");
    expect((p.details as { eventName?: string }).eventName).toBe("Smith - Wedding");
    expect(String(p.notes)).toContain("Lead source: web_form");
    expect(p.location).toBeNull(); // no address → no inventory/pricing on a raw lead

    // The source is also stored on the recorded intake row.
    const intake = listRecentIntakes(50).find((i) => i.id === j.intakeId)!;
    expect(intake.source).toBe("web_form");
  });

  it("dedupes a second lead for the same contact within the window", async () => {
    process.env.WEB_INTAKE_ENABLED = "true";
    const first = (await (await callLead(validLead({ email: "dupe@example.com", phone: "5550000005" }))).json()) as { created: boolean; intakeId: string };
    expect(first.created).toBe(true);

    // Same email, different source + formatting → still the same normalized contact.
    const second = (await (await callLead(validLead({ source: "google_business", email: "Dupe@example.com", phone: "5550000005" }))).json()) as { created: boolean; reason: string; intakeId: string };
    expect(second.created).toBe(false);
    expect(second.reason).toBe("duplicate");
    expect(createOpsFor(second.intakeId)).toHaveLength(0); // no second create op
  });

  it("fires the sales-ai ping only when its flag is on", async () => {
    process.env.WEB_INTAKE_ENABLED = "true";
    await callLead(validLead({ email: "ping1@example.com", phone: "5550000006" }));
    expect(notify).not.toHaveBeenCalled();

    process.env.WEB_INTAKE_SALES_PING = "true";
    await callLead(validLead({ email: "ping2@example.com", phone: "5550000007" }));
    expect(notify).toHaveBeenCalledWith("sales", expect.stringContaining("project queued"));
  });
});

describe("web-lead acknowledgement email (tied to /api/gs/intake-result)", () => {
  beforeEach(() => {
    delete process.env.INTAKE_TOKEN;
    process.env.WEB_INTAKE_ENABLED = "true";
    process.env.WEB_INTAKE_ACK_EMAIL = "true";
  });
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.WEB_INTAKE_ACK_EMAIL;
  });

  it("sends NO ack email by default (the website Zap already thanks the customer)", async () => {
    delete process.env.WEB_INTAKE_ACK_EMAIL;
    const j = (await (await callLead(validLead({ email: "noack@example.com", phone: "5550000010" }))).json()) as { intakeId: string };
    expect(createOpsFor(j.intakeId)).toHaveLength(1); // the project is still queued
    const res = await callIntakeResult({ intakeId: j.intakeId, projectId: "99003", ok: true });
    expect(res.status).toBe(200);
    const emails = listGsOps(200).filter((o) => o.op === "email_send" && o.transactionId === "99003");
    expect(emails).toHaveLength(0);
  });

  it("enqueues an email_send ack ONLY once Goodshuffle confirms the project id", async () => {
    const j = (await (await callLead(validLead({ email: "ack@example.com", phone: "5550000008" }))).json()) as { intakeId: string };

    // Before the callback: no ack email yet for this project.
    const before = listGsOps(200).filter((o) => o.op === "email_send" && o.transactionId === "99001");
    expect(before).toHaveLength(0);

    // Office session reports the created project id back.
    const res = await callIntakeResult({ intakeId: j.intakeId, projectId: "99001", ok: true });
    expect(res.status).toBe(200);

    const emails = listGsOps(200).filter((o) => o.op === "email_send" && o.transactionId === "99001");
    expect(emails).toHaveLength(1);
    const p = emails[0].payload as { content?: string; dedupeKey?: string };
    expect(String(p.content)).toContain("Zoe Events");
    expect(String(p.content)).not.toMatch(/[—–]/); // house style: no dashes
    expect(p.dedupeKey).toBe(`weback:${j.intakeId}`);
  });

  it("does NOT enqueue a second ack when the office reports the same project twice (idempotent)", async () => {
    const j = (await (await callLead(validLead({ email: "ack2@example.com", phone: "5550000009" }))).json()) as { intakeId: string };

    const first = await callIntakeResult({ intakeId: j.intakeId, projectId: "99002", ok: true });
    expect(first.status).toBe(200);
    // A duplicate callback (retry / lost-response re-POST / re-pull) for the same project id.
    const second = await callIntakeResult({ intakeId: j.intakeId, projectId: "99002", ok: true });
    expect(second.status).toBe(200);

    const emails = listGsOps(200).filter((o) => o.op === "email_send" && o.transactionId === "99002");
    expect(emails).toHaveLength(1); // still exactly one ack — the customer is not double-emailed
  });
});
