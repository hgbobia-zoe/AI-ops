// Cold email hand off (Instantly + Smartlead) + contact ownership + shared do-not-contact list. Made-up
// companies, emails, keys and campaign ids.
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";
import { setJson } from "@/lib/kv";
import { upsertOpportunity, upsertEntity } from "@/lib/opportunity/store";
import { insertEnrollment, insertTask, isSuppressed, addSuppression, normalizeSuppressionValue, getEnrollment, getTasksForEnrollment } from "./store";
import {
  pushLeadsToSmartlead, complianceFooter, sequencerConfigured, DEFAULT_MAILING_ADDRESS, activeProvider, setActiveProvider,
  unsupportedProvider, providerApiKey, validCampaignId, probeProvider,
} from "./sequencer";
import { pushLeadsToInstantly, toInstantlyLead, instantlyStatusLabel } from "./instantly";
import { bookingKeepsContact, contactOwner } from "./contactOwnership";
import { pushCandidates, pushApproved, logOutcome } from "./service";
import { setSecret } from "@/lib/secrets";

const NOW = new Date("2026-11-07T15:00:00Z");
const TODAY = "2026-11-07";
const CAMPAIGN = "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d";

afterEach(() => {
  delete process.env.SEQUENCER_PROVIDER;
  delete process.env.SEQUENCER_API_KEY;
  setJson("prospecting.provider", null);
  for (const k of ["smartlead.apiKey", "smartlead.campaignId", "instantly.apiKey", "instantly.campaignId"]) setSecret(k, "");
});

function okFetch(body: unknown) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
}

describe("pushLeadsToSmartlead", () => {
  it("batches at 100 and reads added / skipped", async () => {
    const f = okFetch({ added_count: 100, skipped_count: 0, skipped_leads: [] });
    const leads = Array.from({ length: 150 }, (_, i) => ({ email: `p${i}@example.com` }));
    const r = await pushLeadsToSmartlead(leads, { key: "K", campaignId: "42", fetchImpl: f });
    expect(f).toHaveBeenCalledTimes(2);
    const [url, init] = f.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toContain("/campaigns/42/leads?api_key=K");
    const sent = JSON.parse(init.body);
    expect(sent.lead_list).toHaveLength(100);
    expect(sent.settings.ignore_unsubscribe_list).toBe(false);
    expect(r.ok).toBe(true);
  });

  it("reports skipped emails and keeps the key out of errors", async () => {
    const skipped = await pushLeadsToSmartlead([{ email: "A@example.com" }, { email: "b@example.com" }], {
      key: "SECRET",
      campaignId: "42",
      fetchImpl: okFetch({ added_count: 1, skipped_count: 1, skipped_leads: [{ email: "A@example.com" }] }),
    });
    expect(skipped.added).toBe(1);
    expect(skipped.skippedEmails).toEqual(["a@example.com"]);

    const failed = await pushLeadsToSmartlead([{ email: "c@example.com" }], {
      key: "SECRET",
      campaignId: "42",
      fetchImpl: vi.fn(async () => { throw new Error("connect failed for https://server.smartlead.ai/?api_key=SECRET"); }),
    });
    expect(failed.ok).toBe(false);
    expect(failed.failedEmails).toEqual(["c@example.com"]);
    expect(failed.errors.join(" ")).not.toContain("SECRET");
  });
});

describe("compliance footer and config", () => {
  it("uses a real postal address", () => {
    expect(complianceFooter()).toContain(DEFAULT_MAILING_ADDRESS);
    expect(complianceFooter()).toContain('Reply "remove"');
  });
  it("is connected only when the ACTIVE tool has key + campaign", () => {
    expect(activeProvider()).toBe("instantly"); // the default
    expect(sequencerConfigured()).toBe(false);
    setSecret("smartlead.apiKey", "K");
    setSecret("smartlead.campaignId", "42");
    expect(sequencerConfigured()).toBe(false); // Smartlead is set up, but Instantly is active
    setActiveProvider("smartlead");
    expect(sequencerConfigured()).toBe(true);
    setActiveProvider("instantly");
    setSecret("instantly.apiKey", "IK");
    setSecret("instantly.campaignId", CAMPAIGN);
    expect(sequencerConfigured()).toBe(true);
  });

  it("flags an unsupported SEQUENCER_PROVIDER until a tool is picked in the app", () => {
    process.env.SEQUENCER_PROVIDER = "lemlist";
    setSecret("instantly.apiKey", "IK");
    setSecret("instantly.campaignId", CAMPAIGN);
    expect(unsupportedProvider()).toBe("lemlist");
    expect(sequencerConfigured()).toBe(false);
    setActiveProvider("instantly");
    expect(unsupportedProvider()).toBeNull();
    expect(sequencerConfigured()).toBe(true);
  });

  it("uses SEQUENCER_PROVIDER when nothing is picked, and never sends the env key to the other tool", () => {
    process.env.SEQUENCER_PROVIDER = "smartlead";
    process.env.SEQUENCER_API_KEY = "ENVKEY";
    expect(activeProvider()).toBe("smartlead");
    expect(providerApiKey("smartlead")).toBe("ENVKEY");
    expect(providerApiKey("instantly")).toBeNull();
  });

  it("checks the campaign id shape per tool", () => {
    expect(validCampaignId("smartlead", "1234567")).toBe(true);
    expect(validCampaignId("smartlead", CAMPAIGN)).toBe(false);
    expect(validCampaignId("instantly", CAMPAIGN)).toBe(true);
    expect(validCampaignId("instantly", "1234567")).toBe(false);
  });
});

describe("pushLeadsToInstantly", () => {
  it("posts to /leads/add with a bearer key, skip_if_in_workspace, and custom variables", async () => {
    const f = okFetch({ status: "success", leads_uploaded: 1, created_leads: [{ index: 0, id: "L1", email: "a@example.com" }] });
    const r = await pushLeadsToInstantly(
      [{ email: "A@example.com", company: "A Co", location: "Washington, DC", vars: { intro_subject: "Hi", intro_body: "Body" } }],
      { key: "IK", campaignId: CAMPAIGN, fetchImpl: f },
    );
    const [url, init] = f.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("https://api.instantly.ai/api/v2/leads/add");
    expect(init.headers.authorization).toBe("Bearer IK");
    expect(url).not.toContain("IK");
    const sent = JSON.parse(init.body);
    expect(sent.campaign_id).toBe(CAMPAIGN);
    expect(sent.skip_if_in_workspace).toBe(true);
    expect(sent.leads[0]).toEqual({ email: "A@example.com", company_name: "A Co", custom_variables: { intro_subject: "Hi", intro_body: "Body", location: "Washington, DC" } });
    expect(r).toMatchObject({ ok: true, provider: "instantly", added: 1, skipped: 0 });
  });

  it("counts anything not in created_leads as skipped", async () => {
    const f = okFetch({ leads_uploaded: 1, in_blocklist: 1, created_leads: [{ email: "b@example.com" }] });
    const r = await pushLeadsToInstantly([{ email: "a@example.com", vars: {} }, { email: "B@example.com", vars: {} }], { key: "IK", campaignId: CAMPAIGN, fetchImpl: f });
    expect(r.added).toBe(1);
    expect(r.skippedEmails).toEqual(["a@example.com"]);
  });

  it("batches at 100", async () => {
    const f = vi.fn(async (_u: string, init?: { body?: string }) => {
      const leads = JSON.parse(init!.body!).leads as { email: string }[];
      return { ok: true, status: 200, json: async () => ({ leads_uploaded: leads.length, created_leads: leads.map((l) => ({ email: l.email })) }) };
    });
    const leads = Array.from({ length: 150 }, (_, i) => ({ email: `p${i}@example.com`, vars: {} }));
    const r = await pushLeadsToInstantly(leads, { key: "IK", campaignId: CAMPAIGN, fetchImpl: f });
    expect(f).toHaveBeenCalledTimes(2);
    expect(r.added).toBe(150);
  });

  it("does not guess when Instantly accepts some without saying which", async () => {
    const r = await pushLeadsToInstantly([{ email: "a@example.com", vars: {} }, { email: "b@example.com", vars: {} }], { key: "IK", campaignId: CAMPAIGN, fetchImpl: okFetch({ leads_uploaded: 1 }) });
    expect(r.ok).toBe(false);
    expect(r.added).toBe(0);
    expect(r.failedEmails).toEqual(["a@example.com", "b@example.com"]);
  });

  it("explains HTTP errors and keeps the key out of them", async () => {
    const f = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ message: "Invalid key SECRETKEY" }) }));
    const r = await pushLeadsToInstantly([{ email: "c@example.com", vars: {} }], { key: "SECRETKEY", campaignId: CAMPAIGN, fetchImpl: f });
    expect(r.ok).toBe(false);
    expect(r.failedEmails).toEqual(["c@example.com"]);
    expect(r.errors[0]).toContain("check the API key");
    expect(r.errors.join(" ")).not.toContain("SECRETKEY");
  });

  it("leaves out empty optional fields", () => {
    expect(toInstantlyLead({ email: "x@example.com", vars: {} })).toEqual({ email: "x@example.com", custom_variables: {} });
  });
});

describe("Instantly campaign check", () => {
  it("reads the campaign name and status", async () => {
    setSecret("instantly.apiKey", "IK");
    setSecret("instantly.campaignId", CAMPAIGN);
    const f = okFetch({ id: CAMPAIGN, name: "Radar Tier B", status: 0 });
    const r = await probeProvider("instantly", f);
    expect(r).toEqual({ ok: true, campaignName: "Radar Tier B", status: "draft" });
    const [url, init] = f.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe(`https://api.instantly.ai/api/v2/campaigns/${CAMPAIGN}`);
    expect(init.headers.authorization).toBe("Bearer IK");
  });
  it("labels status codes", () => {
    expect(instantlyStatusLabel(1)).toBe("active");
    expect(instantlyStatusLabel(-2)).toBe("bounce protection on");
    expect(instantlyStatusLabel(7)).toBe("status 7");
  });
});

describe("do-not-contact list", () => {
  it("normalizes phones and domains and matches them", () => {
    expect(normalizeSuppressionValue("phone", "+1 (301) 555-0100")).toBe("3015550100");
    expect(normalizeSuppressionValue("domain", "https://www.Example.com/x")).toBe("example.com");
    addSuppression("phone", "(301) 555-0100", "texted STOP", "Customer", NOW);
    expect(isSuppressed({ phone: "301-555-0100" })).toBe(true);
    addSuppression("domain", "blocked.example", null, null, NOW);
    expect(isSuppressed({ email: "anyone@blocked.example" })).toBe(true);
  });
});

describe("contact ownership (Sales OS wins)", () => {
  it("keeps open quotes and recent customers with Sales OS", () => {
    expect(bookingKeepsContact({ signed: 0, archived: 0, event_date: "2025-01-01", status_label: "Quote" }, TODAY)).toBe(true);
    expect(bookingKeepsContact({ signed: 1, archived: 0, event_date: "2026-06-01", status_label: "Signed" }, TODAY)).toBe(true);
    expect(bookingKeepsContact({ signed: 1, archived: 0, event_date: "2024-06-01", status_label: "Signed" }, TODAY)).toBe(false);
    expect(bookingKeepsContact({ signed: 0, archived: 0, event_date: "2024-06-01", status_label: "Lost" }, TODAY)).toBe(false);
    expect(bookingKeepsContact({ signed: 0, archived: 1, event_date: null, status_label: "Quote" }, TODAY)).toBe(false);
  });

  it("matches a booking by email or phone", () => {
    getDb()
      .prepare("INSERT INTO bookings (booking_id, event_name, event_date, status_label, signed, client_email, client_phone, updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("GS1", "Gala", "2026-12-01", "Quote", 0, "Planner@Venue.example", "(240) 555-0199", NOW.toISOString());
    expect(contactOwner({ email: "planner@venue.example" }, TODAY).owner).toBe("salesos");
    expect(contactOwner({ phone: "2405550199" }, TODAY).owner).toBe("salesos");
    expect(contactOwner({ email: "new@prospect.example" }, TODAY).owner).toBe("radar");
  });
});

function seedEnrollment(email: string, company: string) {
  const opp = upsertOpportunity({ dedupeKey: `t:${email}`, kind: "EVENT", name: `${company} gala`, jurisdiction: "DC", region: "DC", city: "Washington", state: "DC", organization: company }, NOW);
  const ent = upsertEntity({ name: company, kind: "EVENT_PLANNER", website: null, email, phone: null, jurisdiction: null, verificationStatus: "VERIFIED", matchedCustomerKey: null, notes: null, isSeed: false }, NOW);
  const enr = insertEnrollment({ opportunityId: opp.id, entityId: ent.id, tier: "B", cadenceKey: "tier-b", channel: "email", status: "active", owner: "Rep", nextActionAt: TODAY }, NOW);
  insertTask({ enrollmentId: enr.id, opportunityId: opp.id, entityId: ent.id, channel: "email", stepIndex: 0, dueAt: TODAY, subject: "Rentals for your gala", body: `Hi${complianceFooter()}`, script: null }, NOW);
  insertTask({ enrollmentId: enr.id, opportunityId: opp.id, entityId: ent.id, channel: "email", stepIndex: 2, dueAt: "2026-11-10", subject: "Re: Rentals", body: "Follow up", script: null }, NOW);
  return enr;
}

describe("approved Smartlead push", () => {
  it("lists due leads with blockers and pushes only approved, eligible ones", async () => {
    const good = seedEnrollment("events@newco.example", "NewCo Events");
    const owned = seedEnrollment("planner@venue.example", "Venue Group"); // Sales OS owns (booking above is per test file DB; re-seed)
    getDb()
      .prepare("INSERT OR REPLACE INTO bookings (booking_id, event_name, event_date, status_label, signed, client_email, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("GS2", "Venue party", "2026-12-05", "Quote", 0, "planner@venue.example", NOW.toISOString());
    addSuppression("email", "nope@blocked.example", null, null, NOW);
    const blocked = seedEnrollment("nope@blocked.example", "Blocked LLC");

    const list = pushCandidates(NOW);
    const byId = Object.fromEntries(list.map((c) => [c.enrollmentId, c]));
    expect(byId[good.id].eligible).toBe(true);
    expect(byId[good.id].body).not.toMatch(/\(Intro email:/);
    expect(byId[owned.id].blockers.join(" ")).toContain("Sales OS owns");
    expect(byId[blocked.id].blockers).toContain("on the do-not-contact list");

    setActiveProvider("smartlead");
    setSecret("smartlead.apiKey", "K");
    setSecret("smartlead.campaignId", "42");
    const f = okFetch({ added_count: 1, skipped_count: 0, skipped_leads: [] });
    const res = await pushApproved([good.id, owned.id], "Owner", NOW, f);
    expect(res.provider).toBe("Smartlead");
    expect(res.added).toBe(1);
    expect(res.skipped.map((s) => s.enrollmentId)).toContain(owned.id);
    const sent = JSON.parse((f.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(sent.lead_list).toHaveLength(1);
    expect(sent.lead_list[0].custom_fields.intro_subject).toBe("Rentals for your gala");
    expect(getEnrollment(good.id)?.sequencerPushedAt).toBeTruthy();
    expect(getTasksForEnrollment(good.id).every((t) => t.exportedAt)).toBe(true);

    // Not listed again once handed off.
    expect(pushCandidates(NOW).some((c) => c.enrollmentId === good.id)).toBe(false);
  });

  it("refuses to push when the active tool is not connected", async () => {
    const enr = seedEnrollment("x@fresh.example", "Fresh Co");
    setSecret("smartlead.apiKey", "K"); // set up, but not the active tool
    setSecret("smartlead.campaignId", "42");
    const f = okFetch({});
    const res = await pushApproved([enr.id], "Owner", NOW, f);
    expect(res.ok).toBe(false);
    expect(res.added).toBe(0);
    expect(res.errors[0]).toContain("Instantly is not connected");
    expect(f).not.toHaveBeenCalled();
  });

  it("pushes approved leads to Instantly and records the provider", async () => {
    const good = seedEnrollment("hello@instco.example", "InstCo");
    const dup = seedEnrollment("again@instco2.example", "InstCo Two");
    setSecret("instantly.apiKey", "IK");
    setSecret("instantly.campaignId", CAMPAIGN);
    const f = okFetch({ leads_uploaded: 1, skipped_count: 1, created_leads: [{ index: 0, id: "L1", email: "hello@instco.example" }] });
    const res = await pushApproved([good.id, dup.id], "Owner", NOW, f);
    expect(res).toMatchObject({ ok: true, provider: "Instantly", added: 1 });
    expect(res.skipped.find((s) => s.enrollmentId === dup.id)?.reason).toContain("Instantly skipped it");
    const sent = JSON.parse((f.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(sent.leads.map((l: { email: string }) => l.email).sort()).toEqual(["again@instco2.example", "hello@instco.example"]);
    expect(sent.leads.find((l: { email: string }) => l.email === "hello@instco.example").custom_variables.intro_subject).toBe("Rentals for your gala");
    expect(getEnrollment(good.id)).toMatchObject({ sequencerProvider: "instantly", sequencerPushedBy: "Owner" });
    expect(getEnrollment(dup.id)?.sequencerPushedAt).toBeFalsy(); // skipped leads stay unpushed
  });

  it("a bounce or not interested outcome adds the email to the do-not-contact list", () => {
    const enr = seedEnrollment("bounce@gone.example", "Gone Inc");
    const task = getTasksForEnrollment(enr.id)[0];
    logOutcome(task.id, "bounced", "Rep", NOW);
    expect(isSuppressed({ email: "bounce@gone.example" })).toBe(true);
  });
});
