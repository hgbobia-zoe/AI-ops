// Who owns the conversation with a contact. Owner decision (2026-11-07): SALES OS WINS. Anyone who is
// already a Goodshuffle customer or lead (an open quote, or an event in the last year or ahead) belongs to
// Sales OS, and Radar cold outreach must not touch them. Radar only works brand new prospects. Together
// with the shared do-not-contact list (prospect_suppression) this keeps two systems from contacting the
// same person. Deterministic, read only.

import { getDb } from "@/lib/db";
import { shiftYmd, todayInOpsTz } from "@/lib/dates";

export interface Ownership {
  owner: "salesos" | "radar";
  reason: string | null;
  bookingId: string | null;
}

const last10 = (p: string | null | undefined) => (p ?? "").replace(/\D/g, "").slice(-10);

/** PURE. Does a booking row keep this contact with Sales OS? Open (unsigned, not archived) quote, or an
 *  event within the last 365 days or still ahead. */
export function bookingKeepsContact(b: { signed: number | null; archived: number | null; event_date: string | null; status_label: string | null }, today: string): boolean {
  if (b.archived) return false;
  const lost = /lost|cancel/i.test(b.status_label ?? "");
  if (!b.signed && !lost) return true; // open quote / lead
  if (b.event_date && b.event_date >= shiftYmd(today, -365)) return true; // recent or upcoming customer
  return false;
}

/** Who owns this contact? Matches Goodshuffle bookings by client email or phone. */
export function contactOwner(c: { email?: string | null; phone?: string | null }, today: string = todayInOpsTz()): Ownership {
  const email = c.email?.trim().toLowerCase() || null;
  const phone = last10(c.phone);
  if (!email && phone.length !== 10) return { owner: "radar", reason: null, bookingId: null };
  const rows = getDb()
    .prepare(
      `SELECT booking_id, event_name, event_date, status_label, signed, archived, client_email, client_phone
         FROM bookings
        WHERE (? IS NOT NULL AND lower(trim(client_email)) = ?)
           OR (? <> '' AND client_phone IS NOT NULL AND substr(replace(replace(replace(replace(replace(client_phone,'-',''),' ',''),'(',''),')',''),'+',''), -10) = ?)
        ORDER BY event_date DESC
        LIMIT 20`,
    )
    .all(email, email, phone.length === 10 ? phone : "", phone) as {
    booking_id: string;
    event_name: string | null;
    event_date: string | null;
    status_label: string | null;
    signed: number | null;
    archived: number | null;
  }[];
  const hit = rows.find((b) => bookingKeepsContact(b, today));
  if (!hit) return { owner: "radar", reason: null, bookingId: null };
  return { owner: "salesos", reason: `Sales OS owns this contact (Goodshuffle project ${hit.event_name ?? hit.booking_id})`, bookingId: hit.booking_id };
}
