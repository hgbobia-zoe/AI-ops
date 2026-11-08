// Radar → Goodshuffle conversion is intent only, links instead of duplicating, and takes its outcome from
// the booking. Made-up names and emails.
import { describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { upsertOpportunity, getOpportunity } from "./store";
import { conversionProblem, convertOpportunity, linkOpportunityToProject, outcomeFromBooking, splitName, bookingOutcome } from "./conversion";
import { singleView } from "./service";
import { attributeRevenue } from "./analytics";
import { getIntake } from "@/lib/intake/store";
import { isWebLead } from "@/lib/intake/leadSlackReply";

const NOW = new Date("2026-11-07T15:00:00Z");
const TODAY = "2026-11-07";
const contact = { firstName: "Ana", lastName: "Reyes", email: "ana@newco.example", phone: "301-555-0177" };

function opp(key: string, extra: Partial<Parameters<typeof upsertOpportunity>[0]> = {}) {
  return upsertOpportunity({ dedupeKey: key, kind: "EVENT", name: "NewCo Holiday Gala", jurisdiction: "DC", region: "DC", city: "Washington", state: "DC", organization: "NewCo", estimatedDate: "2026-12-12", sourceId: "manual-import", sourceName: "Manual import", ...extra }, NOW);
}

describe("conversionProblem", () => {
  it("requires a confirmed intent and a reachable contact", () => {
    expect(conversionProblem({ intent: { kind: "" as never }, contact })).toMatch(/intent/);
    expect(conversionProblem({ intent: { kind: "asked_for_quote" }, contact: { ...contact, firstName: "", lastName: "" } })).toMatch(/name/);
    expect(conversionProblem({ intent: { kind: "asked_for_quote" }, contact: { ...contact, email: "", phone: "123" } })).toMatch(/email or/);
    expect(conversionProblem({ intent: { kind: "asked_for_quote" }, contact: { ...contact, email: "bad" } })).toMatch(/invalid/);
    expect(conversionProblem({ intent: { kind: "replied_interested" }, contact })).toBeNull();
  });
  it("splits names", () => {
    expect(splitName("Mary Ann Smith")).toEqual({ firstName: "Mary Ann", lastName: "Smith" });
    expect(splitName("Cher")).toEqual({ firstName: "Cher", lastName: "" });
  });
});

describe("convertOpportunity", () => {
  it("queues a create_project op through a radar intake (no welcome email) and links the result", () => {
    const o = opp("conv-1");
    const res = convertOpportunity({ opportunityId: o.id, intent: { kind: "asked_for_quote", note: "Wants 20 tables" }, contact, actor: "Jessie" }, NOW);
    expect(res).toMatchObject({ ok: true, status: "queued" });
    const intakeId = (res as { intakeId: string }).intakeId;
    const intake = getIntake(intakeId)!;
    expect(intake.source).toBe("radar");
    expect(isWebLead(intake)).toBe(false); // no webform welcome email, no #new-leads reply
    expect(intake.salesNotes).toContain("Asked for a quote");
    const op = getDb().prepare("SELECT payload FROM gs_outbox WHERE op='create_project' ORDER BY created_at DESC LIMIT 1").get() as { payload: string };
    const payload = JSON.parse(op.payload);
    expect(payload.intakeId).toBe(intakeId);
    expect(payload.opportunityId).toBe(o.id);
    expect(payload.client.email).toBe("ana@newco.example");
    expect(getOpportunity(o.id)?.salesStatus).toBe("OPPORTUNITY_CREATED");

    // Idempotent: a second click does not queue another project.
    expect(convertOpportunity({ opportunityId: o.id, intent: { kind: "asked_for_quote" }, contact, actor: "Jessie" }, NOW)).toMatchObject({ ok: true, status: "already" });

    // Goodshuffle reports the project: the opportunity is linked.
    expect(linkOpportunityToProject(intakeId, "GS-900")).toBe(o.id);
    expect(getOpportunity(o.id)).toMatchObject({ bookingId: "GS-900", salesStatus: "LINKED" });
  });

  it("refuses without intent", () => {
    const o = opp("conv-2");
    const res = convertOpportunity({ opportunityId: o.id, intent: { kind: "" as never }, contact, actor: "Jessie" }, NOW);
    expect(res.ok).toBe(false);
    expect(getOpportunity(o.id)?.salesStatus).toBe("NONE");
  });

  it("links to the contact's existing Goodshuffle project instead of creating a duplicate", () => {
    getDb()
      .prepare("INSERT INTO bookings (booking_id, event_name, event_date, status_label, signed, client_email, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("GS-EXIST", "Existing quote", "2026-12-20", "Quote", 0, "known@client.example", NOW.toISOString());
    const o = opp("conv-3");
    const before = (getDb().prepare("SELECT COUNT(*) n FROM gs_outbox WHERE op='create_project'").get() as { n: number }).n;
    const res = convertOpportunity({ opportunityId: o.id, intent: { kind: "replied_interested" }, contact: { ...contact, email: "known@client.example", phone: "" }, actor: "Jessie" }, NOW);
    expect(res).toMatchObject({ ok: true, status: "linked_existing", bookingId: "GS-EXIST" });
    const after = (getDb().prepare("SELECT COUNT(*) n FROM gs_outbox WHERE op='create_project'").get() as { n: number }).n;
    expect(after).toBe(before);
  });
});

describe("booking truth and attribution", () => {
  it("derives won / lost / quoted and realized from the booking", () => {
    const row = { booking_id: "B", signed: 1, status_label: "Signed", contract_total: 4200, grand_total: 4500, event_date: "2026-10-01" };
    expect(outcomeFromBooking(row, TODAY)).toMatchObject({ stage: "WON", contractTotal: 4200, realized: true });
    expect(outcomeFromBooking({ ...row, event_date: "2027-01-01" }, TODAY).realized).toBe(false);
    expect(outcomeFromBooking({ ...row, signed: 0, status_label: "Lost" }, TODAY).stage).toBe("LOST");
    expect(outcomeFromBooking({ ...row, signed: 0, status_label: "Quote Sent" }, TODAY).stage).toBe("QUOTED");
  });

  it("the opportunity stage follows the linked booking", () => {
    getDb()
      .prepare("INSERT INTO bookings (booking_id, event_name, event_date, status_label, signed, contract_total, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("GS-SIGNED", "Signed gala", "2026-10-15", "Signed", 1, 5000, NOW.toISOString());
    const o = opp("conv-4");
    getDb().prepare("UPDATE opportunities SET booking_id='GS-SIGNED', sales_status='LINKED' WHERE id=?").run(o.id);
    const v = singleView(o.id, TODAY)!;
    expect(v.stage).toBe("WON");
    expect(bookingOutcome("GS-SIGNED", TODAY)?.realized).toBe(true);
  });

  it("counts each booking once per source", () => {
    const mk = (id: string, bookingId: string | null, source: string, at: string, signed: boolean, amt: number, realized: boolean) => ({
      opp: { id, bookingId, sourceName: source, sourceId: source, discoveredAt: at } as never,
      booking: bookingId ? { bookingId, stage: signed ? "WON" : "QUOTED", signed, contractTotal: amt, eventDate: null, realized, statusLabel: null } as never : null,
    });
    const out = attributeRevenue([
      mk("o1", "B1", "SAM.gov", "2026-01-01", true, 1000, true),
      mk("o2", "B1", "Manual import", "2026-02-01", true, 1000, true), // same booking: not double counted
      mk("o3", "B2", "Manual import", "2026-03-01", true, 500, false),
      mk("o4", "B3", "Manual import", "2026-03-02", false, 900, false),
      mk("o5", null, "SAM.gov", "2026-03-03", false, 0, false),
    ]);
    expect(out.totals).toEqual({ inGoodshuffle: 3, signedBookings: 2, bookedRevenue: 1500, realizedRevenue: 1000 });
    const sam = out.bySource.find((s) => s.key === "SAM.gov")!;
    expect(sam).toMatchObject({ projects: 1, signed: 1, bookedRevenue: 1000, realizedRevenue: 1000 });
  });
});
