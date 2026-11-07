// Smartlead hand off + contact ownership + shared do-not-contact list. Made-up companies and emails.
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";
import { upsertOpportunity, upsertEntity } from "@/lib/opportunity/store";
import { insertEnrollment, insertTask, isSuppressed, addSuppression, normalizeSuppressionValue, getEnrollment, getTasksForEnrollment } from "./store";
import { pushLeadsToSmartlead, complianceFooter, sequencerConfigured, DEFAULT_MAILING_ADDRESS } from "./sequencer";
import { bookingKeepsContact, contactOwner } from "./contactOwnership";
import { pushCandidates, pushApproved, logOutcome } from "./service";
import { setSecret } from "@/lib/secrets";

const NOW = new Date("2026-11-07T15:00:00Z");
const TODAY = "2026-11-07";

afterEach(() => {
  delete process.env.SEQUENCER_PROVIDER;
  setSecret("smartlead.apiKey", "");
  setSecret("smartlead.campaignId", "");
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
  it("is connected only with key + campaign, and never with another provider", () => {
    expect(sequencerConfigured()).toBe(false);
    setSecret("smartlead.apiKey", "K");
    setSecret("smartlead.campaignId", "42");
    expect(sequencerConfigured()).toBe(true);
    process.env.SEQUENCER_PROVIDER = "instantly";
    expect(sequencerConfigured()).toBe(false);
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

    setSecret("smartlead.apiKey", "K");
    setSecret("smartlead.campaignId", "42");
    const f = okFetch({ added_count: 1, skipped_count: 0, skipped_leads: [] });
    const res = await pushApproved([good.id, owned.id], "Owner", NOW, f);
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

  it("refuses to push when Smartlead is not connected", async () => {
    const enr = seedEnrollment("x@fresh.example", "Fresh Co");
    const res = await pushApproved([enr.id], "Owner", NOW, okFetch({}));
    expect(res.ok).toBe(false);
    expect(res.added).toBe(0);
  });

  it("a bounce or not interested outcome adds the email to the do-not-contact list", () => {
    const enr = seedEnrollment("bounce@gone.example", "Gone Inc");
    const task = getTasksForEnrollment(enr.id)[0];
    logOutcome(task.id, "bounced", "Rep", NOW);
    expect(isSuppressed({ email: "bounce@gone.example" })).toBe(true);
  });
});
