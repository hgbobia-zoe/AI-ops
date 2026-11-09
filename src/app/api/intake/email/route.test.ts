import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Side effects inert: audit, Slack and the model are mocked. The DB is the harness's in-memory SQLite.
vi.mock("@/lib/intake/audit", () => ({ logIntakeEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/notify/channels", () => ({ notify: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/notify/sms", () => ({ sendSms: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/notify/slack", async (orig) => ({
  ...(await orig<typeof import("@/lib/notify/slack")>()),
  slackBotConfigured: vi.fn(() => true),
  slackPostAs: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/llm", () => ({ llmConfigured: vi.fn(() => false), chat: vi.fn() }));

import { listGsOps, saveBookings } from "@/lib/db/repo";
import { slackPostAs } from "@/lib/notify/slack";
import { chat, llmConfigured } from "@/lib/llm";
import { getDb } from "@/lib/db";

let n = 0;
/** A Gmail trigger payload, each with its own sender so tests never trip the "one project per sender" rule. */
function gmail(over: Record<string, unknown> = {}, sender?: string) {
  n += 1;
  return {
    message_id: `m${n}`,
    thread_id: `t${n}`,
    labels: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
    from: { name: "Dana Whit", email: sender ?? `dana${n}@gmail.com` },
    subject: "Tent and chairs for a backyard party",
    body_plain: "Hi! We are having a birthday party on June 14 for about 80 guests. Could I get a quote for a tent, tables and chairs, with delivery? Dana 240-555-" + String(1000 + n).slice(-4),
    ...over,
  };
}

async function post(body: unknown, query = "", headers: Record<string, string> = {}) {
  const { POST } = await import("./route");
  const res = await POST(new Request(`http://localhost/api/intake/email${query}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const creates = () => listGsOps(500).filter((o) => o.op === "create_project" && (o.payload as { source?: string }).source === "email");

describe("POST /api/intake/email", () => {
  beforeEach(() => {
    delete process.env.INTAKE_TOKEN;
    delete process.env.EMAIL_INTAKE;
    delete process.env.WEB_INTAKE_ENABLED;
    vi.mocked(llmConfigured).mockReturnValue(false);
    vi.mocked(chat).mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it("dry run decides and echoes, with nothing recorded or queued", async () => {
    const before = creates().length;
    const { json } = await post(gmail(), "?dryRun=1");
    expect(json).toMatchObject({ ok: true, dryRun: true, decision: "lead", by: "rules", created: false, eventName: "Whit - Email" });
    expect(creates().length).toBe(before);
  });

  it("a new inquiry gets the web form path: one Goodshuffle project, never a second for the same sender", async () => {
    const sender = "new.client@gmail.com";
    const { json } = await post(gmail({}, sender), "?slack=1");
    expect(json).toMatchObject({ decision: "lead", created: true });
    const ops = creates().filter((o) => (o.payload as { leadEmail?: string }).leadEmail === sender);
    expect(ops).toHaveLength(1);
    expect(ops[0].payload).toMatchObject({ kind: "web_lead", source: "email", leadEmail: sender, eventName: "Whit - Email" });
    expect(String((ops[0].payload as { notes: string }).notes)).toContain("Came in by email to hello@");
    expect(vi.mocked(slackPostAs).mock.calls[0][1]).toMatchObject({ name: "New Email Lead" });

    const again = await post(gmail({ subject: "Also need linens" }, sender));
    expect(again.json).toMatchObject({ decision: "skip", by: "lookup" });
    expect(String(again.json.reason)).toMatch(/^already_lead/);
    expect(creates().filter((o) => (o.payload as { leadEmail?: string }).leadEmail === sender)).toHaveLength(1);
  });

  it("an existing Goodshuffle customer or open lead belongs to Sales OS: no project, no welcome email", async () => {
    saveBookings([{ bookingId: "B-OPEN", eventName: "Open Quote", eventDate: "2027-05-01", statusLabel: "Quote Sent", signed: false, grandTotal: 1000, clientName: "Open Client", clientEmail: "open.client@gmail.com", clientPhone: "" }]);
    const { json } = await post(gmail({}, "open.client@gmail.com"));
    expect(json).toMatchObject({ decision: "skip", by: "lookup", created: false });
    expect(String(json.reason)).toMatch(/^existing_contact/);
  });

  it("noise never reaches the model", async () => {
    vi.mocked(llmConfigured).mockReturnValue(true);
    const own = await post(gmail({}, "jessie@zoeeventsdmv.com"));
    const promo = await post(gmail({ labels: ["CATEGORY_PROMOTIONS"] }, "deals@partystore.com"));
    const reply = await post(gmail({ subject: "RE: your quote" }));
    expect([own.json.reason, promo.json.reason, reply.json.reason].map((r) => String(r).split(":")[0])).toEqual(["own_address", "automated", "reply"]);
    expect(chat).not.toHaveBeenCalled();
  });

  it("the model confirms intent and fills the details; a pitch the rules let through is dropped", async () => {
    vi.mocked(llmConfigured).mockReturnValue(true);
    vi.mocked(chat).mockResolvedValueOnce({ ok: true, text: '{"intent":"new_inquiry","confidence":0.92,"firstName":"Danielle","lastName":"Whitaker","eventType":"social","eventDate":"2027-06-14","guestCount":80,"summary":"Birthday party tent quote"}' });
    const sender = "danielle.w@gmail.com";
    const lead = await post(gmail({}, sender));
    expect(lead.json).toMatchObject({ decision: "lead", by: "model", created: true });
    const op = creates().find((o) => (o.payload as { leadEmail?: string }).leadEmail === sender)!;
    expect(op.payload).toMatchObject({ eventName: "Whitaker - Social / Private", eventDateMDY: "6/14/2027" });

    vi.mocked(chat).mockResolvedValueOnce({ ok: true, text: '```json\n{"intent":"vendor_or_pitch","confidence":0.9,"summary":"A tent supplier offering wholesale prices"}\n```' });
    const pitch = await post(gmail({ subject: "Tent quote for your rental business" }));
    expect(pitch.json).toMatchObject({ decision: "skip", by: "model", created: false });
    expect(String(pitch.json.reason)).toMatch(/^not_a_lead \(vendor_or_pitch\)/);
  });

  it("anything unclear is held for a person, never auto answered", async () => {
    const before = creates().length;
    const { json } = await post(gmail({ subject: "Question", body_plain: "Hi, could someone call me back when you have a minute?" }), "?slack=1");
    expect(json).toMatchObject({ decision: "review", created: false });
    expect(creates().length).toBe(before);
    const call = vi.mocked(slackPostAs).mock.calls.at(-1)!;
    expect(call[1]).toMatchObject({ name: "Email Triage" });
    expect(String(call[2])).toMatch(/^Possible lead by email to hello@\. No project made and nothing sent/);

    vi.mocked(llmConfigured).mockReturnValue(true);
    vi.mocked(chat).mockResolvedValueOnce({ ok: true, text: '{"intent":"new_inquiry","confidence":0.4,"summary":"Might want chairs"}' });
    const low = await post(gmail({ subject: "chairs?", body_plain: "do you have chairs" }));
    expect(low.json).toMatchObject({ decision: "review", by: "model" });
  });

  it("is token gated like the web form receiver, has a kill switch, and keeps an audit list", async () => {
    process.env.INTAKE_TOKEN = "secret";
    expect((await post(gmail())).status).toBe(401);
    expect((await post(gmail(), "?soft=1")).json).toMatchObject({ ok: false, error: "unauthorized" });
    const ok = await post(gmail({ subject: "RE: thanks" }), "", { "x-intake-token": "secret" });
    expect(ok.json).toMatchObject({ decision: "skip" });

    const { GET } = await import("./route");
    expect((await GET(new Request("http://localhost/api/intake/email"))).status).toBe(401);
    const list = (await (await GET(new Request("http://localhost/api/intake/email", { headers: { "x-intake-token": "secret" } }))).json()) as { recent: { subject: string }[] };
    expect(list.recent[0].subject).toBe("RE: thanks");

    process.env.EMAIL_INTAKE = "false";
    expect((await post(gmail(), "", { "x-intake-token": "secret" })).json).toMatchObject({ created: false, reason: expect.stringContaining("off") });
    expect(getDb()).toBeTruthy();
  });
});
