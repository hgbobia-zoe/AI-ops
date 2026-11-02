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

  it("soft mode never answers with an error status (a Zap's later steps keep running)", async () => {
    const { POST } = await import("./route");
    const bad = await POST(new Request("http://localhost/api/intake/lead?soft=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ firstName: "No", lastName: "Contact" }) }));
    expect(bad.status).toBe(200);
    expect(await bad.json()).toMatchObject({ ok: false, created: false, error: "email_or_phone_required" });
    process.env.INTAKE_TOKEN = "s3cret";
    const unauth = await POST(new Request("http://localhost/api/intake/lead?soft=1", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(unauth.status).toBe(200);
    expect((await unauth.json()).error).toBe("unauthorized");
  });

  it("dryRun only parses and echoes the lead (nothing recorded, no project)", async () => {
    process.env.WEB_INTAKE_ENABLED = "true";
    const before = listRecentIntakes(500).length;
    const { POST } = await import("./route");
    const r = await POST(new Request("http://localhost/api/intake/lead?dryRun=1&slack=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ temporary_email_address: "leadsapi+dry@messaging.yelp.com", user: { display_name: "Dee R." } }) }));
    const j = (await r.json()) as { ok: boolean; dryRun: boolean; eventName: string; slackText: string };
    expect(j).toMatchObject({ ok: true, dryRun: true, eventName: "Dee R. - Yelp" });
    expect(j.slackText).toContain("leadsapi+dry@messaging.yelp.com");
    expect(listRecentIntakes(500).length).toBe(before);
  });

  it("accepts a raw Yelp lead and creates the project", async () => {
    process.env.WEB_INTAKE_ENABLED = "true";
    const { POST } = await import("./route");
    const r = await POST(new Request("http://localhost/api/intake/lead?slack=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ temporary_email_address: "leadsapi+raw@messaging.yelp.com", user: { display_name: "Ray W." }, project: { additional_info: "Need 40 chairs" } }) }));
    const j = (await r.json()) as { created: boolean; intakeId: string };
    expect(j.created).toBe(true);
    const p = createOpsFor(j.intakeId)[0].payload as Record<string, unknown>;
    expect(p.source).toBe("yelp");
    expect(p.eventName).toBe("Ray W. - Yelp");
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

describe("web-lead welcome email (Goodshuffle template, tied to /api/gs/intake-result)", () => {
  const welcomeOps = (projectId: string) => listGsOps(200).filter((o) => o.op === "email_template" && o.transactionId === projectId);

  beforeEach(() => {
    delete process.env.INTAKE_TOKEN;
    delete process.env.WEB_LEAD_EMAIL_TEMPLATE;
    process.env.WEB_INTAKE_ENABLED = "true";
    process.env.WEB_INTAKE_ACK_EMAIL = "true";
  });
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.WEB_INTAKE_ACK_EMAIL;
  });

  it("sends NO welcome email while its switch is off (default)", async () => {
    delete process.env.WEB_INTAKE_ACK_EMAIL;
    const j = (await (await callLead(validLead({ email: "noack@example.com", phone: "5550000010" }))).json()) as { intakeId: string };
    expect(createOpsFor(j.intakeId)).toHaveLength(1); // the project is still queued
    const res = await callIntakeResult({ intakeId: j.intakeId, projectId: "99003", ok: true });
    expect(res.status).toBe(200);
    expect(welcomeOps("99003")).toHaveLength(0);
  });

  it("queues the template email ONLY once Goodshuffle confirms the project id", async () => {
    const j = (await (await callLead(validLead({ email: "ack@example.com", phone: "5550000008" }))).json()) as { intakeId: string };
    expect(welcomeOps("99001")).toHaveLength(0); // nothing before the project exists

    const res = await callIntakeResult({ intakeId: j.intakeId, projectId: "99001", ok: true });
    expect(res.status).toBe(200);

    const ops = welcomeOps("99001");
    expect(ops).toHaveLength(1);
    expect(ops[0].payload).toEqual({ templateName: "New Webform Submission", dedupeKey: `welcome:${j.intakeId}` });
    // The old reply-into-thread acknowledgement is gone (a new project has no thread to reply into).
    expect(listGsOps(200).filter((o) => o.op === "email_send" && o.transactionId === "99001")).toHaveLength(0);
  });

  it("never queues a second welcome when the office reports the same project twice", async () => {
    const j = (await (await callLead(validLead({ email: "ack2@example.com", phone: "5550000009" }))).json()) as { intakeId: string };
    expect((await callIntakeResult({ intakeId: j.intakeId, projectId: "99002", ok: true })).status).toBe(200);
    expect((await callIntakeResult({ intakeId: j.intakeId, projectId: "99002", ok: true })).status).toBe(200);
    expect(welcomeOps("99002")).toHaveLength(1);
  });

  it("skips a lead with no email (phone-only)", async () => {
    const j = (await (await callLead({ source: "yelp", firstName: "Phone", lastName: "Only", phone: "5550000011" })).json()) as { intakeId: string };
    expect((await callIntakeResult({ intakeId: j.intakeId, projectId: "99004", ok: true })).status).toBe(200);
    expect(welcomeOps("99004")).toHaveLength(0);
  });

  it("skips Yelp leads (the Yelp Zap already auto-replies inside Yelp)", async () => {
    const j = (await (await callLead(validLead({ source: "yelp", email: "leadsapi+abc@messaging.yelp.com", phone: "5550000013" }))).json()) as { intakeId: string };
    expect((await callIntakeResult({ intakeId: j.intakeId, projectId: "99006", ok: true })).status).toBe(200);
    expect(welcomeOps("99006")).toHaveLength(0);
  });

  it("uses the template named in WEB_LEAD_EMAIL_TEMPLATE", async () => {
    process.env.WEB_LEAD_EMAIL_TEMPLATE = "Yelp Welcome";
    const j = (await (await callLead(validLead({ email: "named@example.com", phone: "5550000012" }))).json()) as { intakeId: string };
    await callIntakeResult({ intakeId: j.intakeId, projectId: "99005", ok: true });
    expect((welcomeOps("99005")[0].payload as { templateName: string }).templateName).toBe("Yelp Welcome");
  });
});
