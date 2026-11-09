// Purchased contact lists: import, screening, approved push, outcomes. Made-up companies, emails and keys.
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";
import { setJson } from "@/lib/kv";
import { setSecret } from "@/lib/secrets";
import { getOpportunity } from "@/lib/opportunity/store";
import { addSuppression, isSuppressed } from "./store";
import {
  mapColumns, parseListCsv, importList, screenedContacts, buildScreenIndex, pushListContacts, logListOutcome, listStats,
  deleteList, getListContact, updateList, convertedOpportunityIds,
} from "./lists";

const NOW = new Date("2026-11-08T15:00:00Z");
const CAMPAIGN = "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d";
const LIST_CAMPAIGN = "9f8e7d6c-5b4a-4f3e-8d2c-1b0a9f8e7d6c";

afterEach(() => {
  setJson("prospecting.provider", null);
  for (const k of ["instantly.apiKey", "instantly.campaignId", "smartlead.apiKey", "smartlead.campaignId"]) setSecret(k, "");
});

const created = (emails: string[]) => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ leads_uploaded: emails.length, created_leads: emails.map((email) => ({ email })) }) }));

describe("mapping list columns", () => {
  it("recognizes Apollo / ZoomInfo style headers", () => {
    const m = mapColumns(["first name", "last name", "title", "company name", "work email", "website", "company phone", "city", "state"]);
    expect(m).toMatchObject({ email: "work email", first_name: "first name", company: "company name", phone: "company phone" });
  });

  it("parses, splits full names, drops bad and repeated emails", () => {
    const csv = [
      "Contact Name,Email Address,Venue Name,City,State",
      'Ana Maria Ruiz,ana@hall.example,"The Hall, Inc.",Bethesda,MD',
      "Bo,BO@hall.example,The Hall,Bethesda,MD",
      "Bo again,bo@hall.example,The Hall,Bethesda,MD",
      "No Email,,Somewhere,,",
      "Bad,not-an-email,Bad Co,,",
    ].join("\n");
    const r = parseListCsv(csv);
    expect(r.rows).toBe(5);
    expect(r.contacts.map((c) => c.email)).toEqual(["ana@hall.example", "bo@hall.example"]);
    expect(r.contacts[0]).toMatchObject({ firstName: "Ana", lastName: "Maria Ruiz", company: "The Hall, Inc.", city: "Bethesda" });
    expect(r).toMatchObject({ duplicatesInFile: 1, missingEmail: 1, invalidEmail: 1 });
  });
});

describe("Apify Google Maps exports", () => {
  // Header shape of the Google Maps Scraper CSV export with the contacts add-on (made-up places).
  const header = "title,categoryName,address,city,state,phone,website,url,totalScore,reviewsCount,placeId,emails/0,emails/1";
  it("reads the business name as the company, not a job title, and takes the first good email", () => {
    const csv = [
      header,
      'The Grand Hall,Wedding venue,"1 Main St, Rockville, MD",Rockville,Maryland,(301) 555-0101,https://grandhall.example,https://www.google.com/maps/place/x,4.7,212,ChIJaaa,events@grandhall.example,info@grandhall.example',
      "Garden Loft,Event venue,,Bethesda,Maryland,,https://loft.example,https://www.google.com/maps/place/y,4.5,40,ChIJbbb,not-an-email,hello@loft.example",
      "No Site Barn,Barn venue,,Frederick,Maryland,(301) 555-0199,,https://www.google.com/maps/place/z,4.9,15,ChIJccc,,",
    ].join("\n");
    const r = parseListCsv(csv);
    expect(r.source).toBe("google_maps");
    expect(r.contacts).toHaveLength(2);
    expect(r.contacts[0]).toMatchObject({ email: "events@grandhall.example", company: "The Grand Hall", title: null, website: "https://grandhall.example", city: "Rockville", firstName: null });
    expect(r.contacts[1]).toMatchObject({ email: "hello@loft.example", company: "Garden Loft" });
    expect(r.missingEmail).toBe(1);
  });

  it("explains how to get emails when the export has none", () => {
    const csv = "title,categoryName,city,phone,website,totalScore,placeId\nThe Grand Hall,Wedding venue,Rockville,(301) 555-0101,https://grandhall.example,4.7,ChIJaaa";
    expect(() => importList({ name: "Maps", segment: "venue" }, csv, "Owner", NOW)).toThrow(/Company contacts enrichment/);
  });

  it("leaves Apollo style files alone", () => {
    expect(parseListCsv("title,company,email\nEvents Director,The Hall,a@hall.example").contacts[0]).toMatchObject({ title: "Events Director", company: "The Hall" });
    expect(parseListCsv("title,company,email\nEvents Director,The Hall,a@hall.example").source).toBe("generic");
  });
});

describe("importing a list", () => {
  it("creates the list with its contacts and refuses a file with no email column", () => {
    const out = importList({ name: "DMV venues Q4", segment: "venue", vendor: "Apollo", cost: 150 }, "email,company\na@v1.example,V1\nb@v2.example,V2", "Owner", NOW);
    expect(out.imported).toBe(2);
    expect(out.list).toMatchObject({ name: "DMV venues Q4", segment: "venue", cost: 150 });
    expect(() => importList({ name: "x", segment: "venue" }, "name,company\nA,B", "Owner", NOW)).toThrow(/no email column/);
    expect(() => importList({ name: "x", segment: "nope" as never }, "email\na@b.example", "Owner", NOW)).toThrow(/pick who is on the list/);
  });
});

describe("screening", () => {
  it("blocks do-not-contact, Sales OS customers, Zoe's own address, and people already emailed from another list", async () => {
    addSuppression("domain", "blocked.example", null, null, NOW);
    getDb()
      .prepare("INSERT INTO bookings (booking_id, event_name, event_date, status_label, signed, client_email, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("GS-L1", "Open quote", "2026-12-01", "Quote", 0, "customer@client.example", NOW.toISOString());
    const first = importList({ name: "Planners A", segment: "planner" }, "email\nshared@plan.example", "Owner", NOW);
    setSecret("instantly.apiKey", "IK");
    setSecret("instantly.campaignId", CAMPAIGN);
    const firstContact = screenedContacts(first.list.id)[0];
    await pushListContacts(first.list.id, [firstContact.id], "Owner", { fetchImpl: created(["shared@plan.example"]) }, NOW);

    const second = importList(
      { name: "Planners B", segment: "planner" },
      "email\nok@fresh.example\nx@blocked.example\ncustomer@client.example\nme@zoeeventsdmv.com\nshared@plan.example",
      "Owner",
      NOW,
    );
    const byEmail = Object.fromEntries(screenedContacts(second.list.id, buildScreenIndex("2026-11-08")).map((c) => [c.email, c]));
    expect(byEmail["ok@fresh.example"].eligible).toBe(true);
    expect(byEmail["x@blocked.example"].blockers).toContain("on the do-not-contact list");
    expect(byEmail["customer@client.example"].blockers.join(" ")).toContain("Sales OS owns");
    expect(byEmail["me@zoeeventsdmv.com"].blockers).toContain("Zoe's own address");
    expect(byEmail["shared@plan.example"].blockers.join(" ")).toContain('already emailed from list "Planners A"');
  });
});

describe("approved push", () => {
  it("sends only eligible contacts to the list's campaign, with verification, and records the result", async () => {
    setSecret("instantly.apiKey", "IK");
    setSecret("instantly.campaignId", CAMPAIGN);
    addSuppression("email", "stop@corp.example", null, null, NOW);
    const imp = importList({ name: "Office managers", segment: "corporate", campaignId: LIST_CAMPAIGN }, "email,first name,company,title\nyes@corp.example,Kim,Corp,Office Manager\nskip@corp.example,Lou,Corp,\nstop@corp.example,Max,Corp,", "Owner", NOW);
    const ids = screenedContacts(imp.list.id).map((c) => c.id);
    const f = created(["yes@corp.example"]); // Instantly skips skip@ (say it is already in the workspace)
    const res = await pushListContacts(imp.list.id, ids, "Owner", { verify: true, fetchImpl: f }, NOW);
    expect(res).toMatchObject({ ok: true, provider: "Instantly", campaignId: LIST_CAMPAIGN, added: 1 });
    const sent = JSON.parse((f.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(sent.campaign_id).toBe(LIST_CAMPAIGN);
    expect(sent.verify_leads_on_import).toBe(true);
    expect(sent.leads.map((l: { email: string }) => l.email).sort()).toEqual(["skip@corp.example", "yes@corp.example"]); // stop@ never sent
    expect(sent.leads.find((l: { email: string }) => l.email === "yes@corp.example")).toMatchObject({ first_name: "Kim", company_name: "Corp", custom_variables: { segment: "Corporate / office managers", title: "Office Manager", list: "Office managers" } });
    const after = Object.fromEntries(screenedContacts(imp.list.id).map((c) => [c.email, c]));
    expect(after["yes@corp.example"]).toMatchObject({ status: "pushed", provider: "instantly", pushedBy: "Owner" });
    expect(after["skip@corp.example"].status).toBe("skipped");
    expect(after["stop@corp.example"].status).toBe("new");
    expect(res.skipped.map((s) => s.email)).toEqual(expect.arrayContaining(["skip@corp.example", "stop@corp.example"]));

    // A second push sends nothing again.
    const again = await pushListContacts(imp.list.id, ids, "Owner", { fetchImpl: f }, NOW);
    expect(again.added).toBe(0);
    expect(f).toHaveBeenCalledTimes(1);

    // The list can no longer be deleted: it is the record of who was emailed.
    expect(deleteList(imp.list.id).ok).toBe(false);
  });

  it("refuses without a connected tool or with the wrong kind of campaign id", async () => {
    const imp = importList({ name: "Venues", segment: "venue" }, "email\na@venue.example", "Owner", NOW);
    const ids = screenedContacts(imp.list.id).map((c) => c.id);
    const f = created([]);
    expect((await pushListContacts(imp.list.id, ids, "Owner", { fetchImpl: f }, NOW)).errors[0]).toContain("Instantly is not connected");
    setSecret("instantly.apiKey", "IK");
    updateList(imp.list.id, { campaignId: "12345" }, NOW);
    expect((await pushListContacts(imp.list.id, ids, "Owner", { fetchImpl: f }, NOW)).errors[0]).toContain("isn't a valid Instantly campaign id");
    expect(f).not.toHaveBeenCalled();
  });

  it("an unused list can be deleted", () => {
    const imp = importList({ name: "Oops", segment: "other" }, "email\nq@oops.example", "Owner", NOW);
    expect(deleteList(imp.list.id).ok).toBe(true);
  });
});

describe("outcomes", () => {
  it("not interested goes on the do-not-contact list", () => {
    const imp = importList({ name: "Assoc", segment: "association" }, "email\nno@assoc.example", "Owner", NOW);
    const c = screenedContacts(imp.list.id)[0];
    expect(logListOutcome(c.id, "not_interested", "Rep", NOW).ok).toBe(true);
    expect(isSuppressed({ email: "no@assoc.example" })).toBe(true);
  });

  it("interested creates one Engaged Radar opportunity linked to the contact", () => {
    const imp = importList({ name: "Venues MD", segment: "venue", cost: 100 }, "email,first name,last name,company,city,state\nyes@venue.example,Rae,Park,Grand Venue,Rockville,MD", "Owner", NOW);
    const c = screenedContacts(imp.list.id)[0];
    const r = logListOutcome(c.id, "interested", "Rep", NOW);
    expect(r.ok).toBe(true);
    const opp = getOpportunity(r.opportunityId!);
    expect(opp).toMatchObject({ name: "Grand Venue: interested reply", stage: "ENGAGED", organization: "Grand Venue", isSeed: false });
    expect(opp?.sourceName).toBe("Purchased list: Venues MD");
    // Logging interested again does not make a second opportunity.
    expect(logListOutcome(c.id, "interested", "Rep", NOW).opportunityId).toBe(r.opportunityId);
    expect(getListContact(c.id)?.opportunityId).toBe(r.opportunityId);

    const stats = listStats({ cost: 100 }, screenedContacts(imp.list.id), convertedOpportunityIds());
    expect(stats).toMatchObject({ total: 1, replied: 1, interested: 1, opportunities: 1, costPerInterested: 100 });
  });
});
