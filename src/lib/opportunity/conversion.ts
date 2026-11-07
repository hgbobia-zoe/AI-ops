// Opportunity Radar → Goodshuffle, INTENT ONLY. Owner rule (2026-11-07): a Goodshuffle project is created
// only for a prospect who showed intent (replied interested, booked a meeting, or asked for a quote) and
// only when a person confirms it. Never automatically, never for anyone still in cold outreach, so
// Goodshuffle stays uncluttered.
//
// Reuses the existing pipeline: a sales_intake row (source "radar") + the create_project gs_outbox op the
// office Goodshuffle session drains; /api/gs/intake-result reports the project id back and
// linkOpportunityToProject() stores it on the opportunity. A contact Sales OS already has a project for is
// LINKED to that project instead of getting a duplicate. Radar conversions get no webform welcome email.
//
// Booking truth: once linked, the opportunity's outcome comes from the Goodshuffle booking (signed → won,
// lost/cancelled → lost, otherwise quoted) and revenue from its contract total. See bookingOutcome().

import { getDb } from "@/lib/db";
import { createIntake, updateIntake, getIntake } from "@/lib/intake/store";
import { gsEventDetails, gsClientContact, formatIntakeNotes } from "@/lib/intake/format";
import { mdyFromYmd } from "@/lib/intake/gsItems";
import { enqueueGsOp, recentLeadCreateOpExists, insertAudit } from "@/lib/db/repo";
import { logIntakeEvent } from "@/lib/intake/audit";
import { contactOwner } from "@/lib/prospecting/contactOwnership";
import { getEnrollmentByOpportunity } from "@/lib/prospecting/store";
import { todayInOpsTz } from "@/lib/dates";
import { getOpportunity, type StoredOpportunity } from "./store";
import type { LifecycleStage } from "./types";

export type IntentKind = "replied_interested" | "meeting_booked" | "asked_for_quote";
export const INTENT_LABEL: Record<IntentKind, string> = {
  replied_interested: "Replied interested",
  meeting_booked: "Meeting or call booked",
  asked_for_quote: "Asked for a quote",
};

export interface ConvertContact {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

export interface ConvertInput {
  opportunityId: string;
  intent: { kind: IntentKind; note?: string };
  contact: ConvertContact;
  actor: string;
}

export type ConvertResult =
  | { ok: true; status: "queued"; intakeId: string }
  | { ok: true; status: "linked_existing"; bookingId: string }
  | { ok: true; status: "already"; bookingId: string | null; intakeId: string | null }
  | { ok: false; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const digits10 = (p: string) => p.replace(/\D/g, "").slice(-10);

/** PURE. Validate the person's confirmation + contact. Returns the first problem, or null. */
export function conversionProblem(input: Pick<ConvertInput, "intent" | "contact">): string | null {
  if (!input.intent || !(input.intent.kind in INTENT_LABEL)) return "Confirm the prospect's intent (replied interested, meeting booked, or asked for a quote)";
  const c = input.contact;
  if (!c.firstName.trim() && !c.lastName.trim()) return "Enter the contact's name";
  const email = c.email.trim();
  const phone = digits10(c.phone);
  if (!email && phone.length !== 10) return "Enter an email or a 10 digit phone for the contact";
  if (email && !EMAIL_RE.test(email)) return "That email address looks invalid";
  return null;
}

/** PURE. Split a person's name into first / last for the form prefill. */
export function splitName(full: string | null | undefined): { firstName: string; lastName: string } {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

/** Suggested intent: the prospect already replied or booked a meeting in the outreach worklist. */
export function suggestedIntent(opportunityId: string): IntentKind | null {
  const enr = getEnrollmentByOpportunity(opportunityId);
  if (!enr || enr.status !== "replied") return null;
  const row = getDb()
    .prepare("SELECT outcome FROM prospect_tasks WHERE enrollment_id=? AND outcome IN ('meeting','replied') ORDER BY completed_at DESC LIMIT 1")
    .get(enr.id) as { outcome: string } | undefined;
  return row?.outcome === "meeting" ? "meeting_booked" : "replied_interested";
}

function eventNameFor(opp: StoredOpportunity, c: ConvertContact): string {
  const who = c.lastName.trim() || c.firstName.trim() || opp.organization || "Radar";
  return `${who} - ${opp.name}`.slice(0, 80);
}

/** Convert one opportunity, after a person confirmed the prospect's intent. Idempotent. */
export function convertOpportunity(input: ConvertInput, now: Date = new Date()): ConvertResult {
  const opp = getOpportunity(input.opportunityId);
  if (!opp) return { ok: false, error: "opportunity not found" };
  const row = getDb().prepare("SELECT intake_id FROM opportunities WHERE id=?").get(opp.id) as { intake_id: string | null } | undefined;
  if (opp.bookingId || row?.intake_id) return { ok: true, status: "already", bookingId: opp.bookingId, intakeId: row?.intake_id ?? null };

  const problem = conversionProblem(input);
  if (problem) return { ok: false, error: problem };

  const c: ConvertContact = {
    firstName: input.contact.firstName.trim(),
    lastName: input.contact.lastName.trim(),
    email: input.contact.email.trim().toLowerCase(),
    phone: input.contact.phone.trim(),
  };
  const intentJson = JSON.stringify({ kind: input.intent.kind, note: (input.intent.note ?? "").trim().slice(0, 300) });
  const ts = now.toISOString();
  const today = todayInOpsTz(now);

  // Sales OS already has this contact: link to that project, never create a duplicate.
  const own = contactOwner({ email: c.email, phone: c.phone }, today);
  if (own.owner === "salesos" && own.bookingId) {
    getDb()
      .prepare("UPDATE opportunities SET booking_id=?, sales_status='LINKED', conversion_intent=?, converted_by=?, converted_at=?, updated_at=? WHERE id=?")
      .run(own.bookingId, intentJson, input.actor, ts, ts, opp.id);
    audit(input.actor, "opportunity.linked_existing_project", opp.id, { bookingId: own.bookingId, intent: input.intent.kind });
    return { ok: true, status: "linked_existing", bookingId: own.bookingId };
  }

  // A create for the same contact is already in flight (any source, last 10 minutes).
  const phoneKey = c.phone.replace(/\D/g, ""); // same key shape as web leads (all digits)
  if (recentLeadCreateOpExists(c.email, phoneKey)) return { ok: false, error: "A Goodshuffle project for this contact is already being created. Wait a minute and refresh." };

  const intake = createIntake({
    source: "radar",
    createdBy: input.actor,
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    phone: c.phone,
    eventDate: opp.estimatedDate ?? "",
    eventType: opp.kind === "PROCUREMENT" ? "corporate" : "other",
    city: opp.city ?? "",
    state: opp.state ?? "",
    salesNotes: [
      `Opportunity Radar: ${opp.name}`,
      `Intent confirmed by ${input.actor}: ${INTENT_LABEL[input.intent.kind]}${input.intent.note?.trim() ? `. ${input.intent.note.trim()}` : ""}`,
      opp.sourceUrl ? `Source: ${opp.sourceUrl}` : null,
    ].filter(Boolean).join("\n"),
  });
  const eventName = eventNameFor(opp, c);
  const details = { ...gsEventDetails(intake), eventName };
  enqueueGsOp({
    op: "create_project",
    label: `radar conversion ${eventName}`,
    payload: {
      intakeId: intake.id,
      eventName,
      notes: `${formatIntakeNotes(intake)}\n\nLead source: Opportunity Radar (${opp.sourceName ?? opp.sourceId ?? "radar"})`,
      details,
      client: gsClientContact(intake),
      eventDateMDY: mdyFromYmd(opp.estimatedDate ?? ""),
      addItems: [],
      windowUpgrade: null,
      location: null,
      logisticsLegs: [],
      kind: "radar_conversion",
      source: "radar",
      opportunityId: opp.id,
      leadEmail: c.email,
      leadPhone: phoneKey,
    },
  });
  updateIntake(intake.id, { status: "creating", gsStatus: "queued" });
  getDb()
    .prepare("UPDATE opportunities SET intake_id=?, sales_status='OPPORTUNITY_CREATED', conversion_intent=?, converted_by=?, converted_at=?, stage=CASE WHEN stage IN ('WON','LOST','ARCHIVED') THEN stage ELSE 'OPPORTUNITY' END, stage_source='manual', updated_at=? WHERE id=?")
    .run(intake.id, intentJson, input.actor, ts, ts, opp.id);
  void logIntakeEvent("RADAR_CONVERSION_QUEUED", intake.id, { opportunityId: opp.id, intent: input.intent.kind }).catch(() => {});
  audit(input.actor, "opportunity.converted_to_goodshuffle", opp.id, { intakeId: intake.id, intent: input.intent.kind });
  return { ok: true, status: "queued", intakeId: intake.id };
}

/** Called by /api/gs/intake-result once Goodshuffle created the project: link it to its opportunity. */
export function linkOpportunityToProject(intakeId: string, projectId: string, now: Date = new Date()): string | null {
  const row = getDb().prepare("SELECT id FROM opportunities WHERE intake_id=?").get(intakeId) as { id: string } | undefined;
  if (!row) return null;
  getDb().prepare("UPDATE opportunities SET booking_id=?, sales_status='LINKED', updated_at=? WHERE id=?").run(projectId, now.toISOString(), row.id);
  return row.id;
}

/** Conversion state for the detail page. */
export function conversionState(opportunityId: string): {
  intakeId: string | null;
  intakeStatus: string | null;
  intent: { kind: IntentKind; note: string } | null;
  convertedBy: string | null;
  convertedAt: string | null;
} {
  const r = getDb().prepare("SELECT intake_id, conversion_intent, converted_by, converted_at FROM opportunities WHERE id=?").get(opportunityId) as
    | { intake_id: string | null; conversion_intent: string | null; converted_by: string | null; converted_at: string | null }
    | undefined;
  let intent: { kind: IntentKind; note: string } | null = null;
  try {
    intent = r?.conversion_intent ? (JSON.parse(r.conversion_intent) as { kind: IntentKind; note: string }) : null;
  } catch {
    intent = null;
  }
  const intake = r?.intake_id ? getIntake(r.intake_id) : null;
  return { intakeId: r?.intake_id ?? null, intakeStatus: intake?.gsStatus || intake?.status || null, intent, convertedBy: r?.converted_by ?? null, convertedAt: r?.converted_at ?? null };
}

// ── Booking truth ─────────────────────────────────────────────────────────────────────────────────
export interface BookingOutcome {
  bookingId: string;
  stage: Extract<LifecycleStage, "QUOTED" | "WON" | "LOST">;
  signed: boolean;
  contractTotal: number | null; // dollars, from Goodshuffle
  eventDate: string | null;
  realized: boolean; // signed and the event date has passed
  statusLabel: string | null;
}

/** PURE. A booking row → the opportunity outcome. Signed = won; lost / cancelled = lost; else quoted. */
export function outcomeFromBooking(
  b: { booking_id: string; signed: number | null; status_label: string | null; contract_total: number | null; grand_total: number | null; event_date: string | null; archived?: number | null },
  today: string,
): BookingOutcome {
  const signed = !!b.signed;
  const lost = !signed && (/lost|cancel/i.test(b.status_label ?? "") || !!b.archived);
  const total = b.contract_total ?? b.grand_total ?? null;
  return {
    bookingId: b.booking_id,
    stage: signed ? "WON" : lost ? "LOST" : "QUOTED",
    signed,
    contractTotal: total,
    eventDate: b.event_date,
    realized: signed && !!b.event_date && b.event_date < today,
    statusLabel: b.status_label,
  };
}

/** The linked booking's outcome, or null when not linked / not yet pulled from Goodshuffle. */
export function bookingOutcome(bookingId: string | null, today: string = todayInOpsTz()): BookingOutcome | null {
  if (!bookingId) return null;
  const b = getDb()
    .prepare("SELECT booking_id, signed, status_label, contract_total, grand_total, event_date, archived FROM bookings WHERE booking_id=?")
    .get(bookingId) as Parameters<typeof outcomeFromBooking>[0] | undefined;
  return b ? outcomeFromBooking(b, today) : null;
}

function audit(actor: string, action: string, entityId: string, after: unknown): void {
  try {
    insertAudit({ actor, action, entity: "opportunity", entityId, after });
  } catch {
    /* observability only */
  }
}
