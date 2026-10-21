// Web / connector lead intake — the structured receiver shared by every external lead source (web form,
// Yelp, Google Business, and any future source) that POSTs through its own Zapier webhook to
// /api/intake/lead. Every source already sends STRUCTURED fields, so there is NO email/LLM parsing here —
// this module only normalizes, validates, and maps those fields onto the SAME guided-intake → Goodshuffle
// pipeline (createIntake + the create_project gs_outbox op), so a web lead becomes a Goodshuffle project
// shell exactly the way a guided intake does. Pure + client-safe (no DB / node imports) so it is directly
// unit-testable; the route does the I/O.

import type { IntakeEventType, IntakePatch } from "./types";
import { humanize } from "@/lib/salesos/outreach";

// ── Flags (default OFF) ──────────────────────────────────────────────────────────────────────────────
// Master switch. Until WEB_INTAKE_ENABLED === "true" the endpoint ACCEPTS + records a lead (nothing is
// lost) but creates NO Goodshuffle project and sends NO email — so a Zap can be wired + tested safely
// before go-live. Mirrors the EMAIL_SEND_ENABLED / SMS_SEND_ENABLED env-flag convention.
export function webIntakeEnabled(): boolean {
  return process.env.WEB_INTAKE_ENABLED === "true";
}
// Separate, also-default-OFF flag for the quiet sales-ai Slack ping. Off by default so it does not double
// up with the lead source's own Slack notification (e.g. Yelp's native alert).
export function webIntakeSalesPingEnabled(): boolean {
  return process.env.WEB_INTAKE_SALES_PING === "true";
}

/** The tolerant body a source Zap POSTs. Everything optional; unknown/extra fields are ignored. */
export interface WebLeadInput {
  source?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  email?: unknown;
  phone?: unknown;
  eventType?: unknown;
  eventDate?: unknown; // YYYY-MM-DD
  guestCount?: unknown; // number (or numeric string)
  message?: unknown;
  submittedAt?: unknown; // ISO
}

/** A normalized, validated-shape lead. emailKey / phoneKey are the dedupe keys (lowercased email,
 *  digits-only phone). eventType is collapsed onto the intake's own enum; an unrecognized type is kept
 *  verbatim in eventTypeOther (never guessed away). */
export interface NormalizedLead {
  source: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  emailKey: string;
  phoneKey: string;
  eventType: IntakeEventType;
  eventTypeOther: string;
  eventDate: string;
  guestCount: number | null;
  message: string;
  submittedAt: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function toGuestCount(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

// Only YYYY-MM-DD is accepted (every source is documented to send this); anything else is dropped rather
// than guessed, so a malformed date never becomes a wrong Goodshuffle event date.
function toYmd(v: unknown): string {
  const s = str(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

// Collapse a free-text source event type onto the intake enum. Known buckets map directly; anything else
// is "other" with the original text preserved in eventTypeOther so the label + notes stay honest.
function mapEventType(raw: string): { eventType: IntakeEventType; eventTypeOther: string } {
  const s = raw.toLowerCase();
  if (!s) return { eventType: "", eventTypeOther: "" };
  if (/wedding/.test(s)) return { eventType: "wedding", eventTypeOther: "" };
  if (/(corporate|company|business|conference|gala|meeting)/.test(s)) return { eventType: "corporate", eventTypeOther: "" };
  if (/(social|party|birthday|private|baby|graduation|shower|anniversary|reunion|holiday)/.test(s)) return { eventType: "social", eventTypeOther: "" };
  return { eventType: "other", eventTypeOther: raw };
}

export function normalizeLead(raw: WebLeadInput): NormalizedLead {
  const source = str(raw.source) || "web";
  const email = str(raw.email);
  const phone = str(raw.phone);
  const { eventType, eventTypeOther } = mapEventType(str(raw.eventType));
  return {
    source,
    firstName: str(raw.firstName),
    lastName: str(raw.lastName),
    email,
    phone,
    emailKey: email.toLowerCase(),
    phoneKey: phone.replace(/\D/g, ""),
    eventType,
    eventTypeOther,
    eventDate: toYmd(raw.eventDate),
    guestCount: toGuestCount(raw.guestCount),
    message: str(raw.message),
    submittedAt: str(raw.submittedAt),
  };
}

/** Validation: a lead is usable only with at least an email OR a phone (we cannot create or follow up
 *  without a way to reach the customer). Returns an error code (→ 400) or null when OK. */
export function leadValidationError(n: NormalizedLead): string | null {
  if (!n.emailKey && !n.phoneKey) return "email_or_phone_required";
  return null;
}

// Human-readable label for the mapped event type (used in the project name + notes).
function eventTypeLabel(n: NormalizedLead): string {
  switch (n.eventType) {
    case "wedding":
      return "Wedding";
    case "corporate":
      return "Corporate";
    case "social":
      return "Social / Private";
    case "other":
      return n.eventTypeOther.trim() || "Event";
    default:
      return "";
  }
}

/** The Goodshuffle project name for a web lead. Web leads have no street address (unlike a guided intake,
 *  whose convention is "LastName - Street Address"), so we follow the "client name + event type" shape:
 *  "Smith - Wedding". Falls back to just the name when no type is known, and to "New web lead" when the
 *  customer gave no name at all. */
export function webLeadEventName(n: NormalizedLead): string {
  const name = n.lastName.trim() || n.firstName.trim() || "New web lead";
  const label = eventTypeLabel(n);
  return label ? `${name} - ${label}` : name;
}

/** Map the normalized lead onto the sales_intake patch (so a web lead is persisted the same way a guided
 *  one is, and /api/gs/intake-result can update it by id). The raw `source` is stored on the row. */
export function toIntakePatch(n: NormalizedLead): IntakePatch {
  return {
    firstName: n.firstName,
    lastName: n.lastName,
    email: n.email,
    phone: n.phone,
    eventType: n.eventType,
    eventTypeOther: n.eventTypeOther,
    eventDate: n.eventDate,
    guestCount: n.guestCount,
    salesNotes: n.message,
  };
}

// Escape + wrap a one-line body into the simple HTML Goodshuffle's message editor produces.
function toHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<div>${esc}</div>`;
}

/** The short acknowledgement email enqueued once Goodshuffle confirms the project id (see intake-result).
 *  House style: no dashes, no emoji, short + natural (run through humanize()). Goodshuffle appends the
 *  company signature on send, so no sign-off is included here. */
export function buildAckEmail(n: NormalizedLead): { content: string; subject: string } {
  const name = n.firstName.trim() || "there";
  const body = humanize(
    `Hi ${name}, thanks for reaching out to Zoe Events. We received your information and someone from our team will follow up with you soon. We are looking forward to working with you.`,
  );
  return { content: toHtml(body), subject: "Thanks for reaching out to Zoe Events" };
}
