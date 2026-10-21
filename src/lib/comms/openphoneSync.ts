// OpenPhone SMS sync — the API-driven path that keeps a lead's text history complete on the unified
// timeline (comms_events), independent of the inbound/outbound webhook. The webhook gives real-time
// freshness; this gives BACKFILL (past texts a webhook could never recover) and captures texts sent or
// received NATIVELY in the Quo app that the app never recorded. Both paths dedupe on the OpenPhone
// message id (comms_events.provider_id is UNIQUE), so running both is safe and never double-counts.
//
// FACTS ONLY: we insert exactly the messages the OpenPhone API returns, never a synthesized one.
// Governing law: key-gated (a no-op when no OpenPhone API key), bounded, best-effort, NEVER throws.

import { getCustomerTextThread, openphoneApiKey } from "./openphone";
import { getPipelineLeads, insertCommsEventIfNew, type BookingView } from "@/lib/db/repo";
import { todayInOpsTz } from "@/lib/dates";

const last10 = (phone?: string | null): string | null => {
  const d = (phone ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
};

/** Default cap on how many leads a single run syncs — keeps the per-run API fan-out sane (each lead
 *  already loops our Quo numbers inside getCustomerTextThread). */
export const DEFAULT_LEAD_CAP = 80;

/** Sync one lead's full SMS thread (both directions, incl. native-Quo texts) from the OpenPhone API into
 *  comms_events, attaching every message to THIS lead (lead_id = bookingId). Idempotent: each message is
 *  keyed by its OpenPhone message id (provider_id UNIQUE), so already-stored rows — whether captured by
 *  the webhook, the app's own sender, or a prior sync — no-op. Because we start from a known lead, there
 *  is never an unmatched / null-lead row. Best-effort: returns {inserted:0} on any error or when the
 *  thread is empty/unconfigured. */
export async function syncLeadTextThread(bookingId: string, phone: string | null | undefined): Promise<{ inserted: number }> {
  try {
    if (!bookingId || !last10(phone)) return { inserted: 0 };
    const thread = await getCustomerTextThread(phone); // [] when unconfigured / no phone / error — never throws
    let inserted = 0;
    for (const m of thread) {
      if (m.channel !== "sms") continue; // this path syncs texts only; calls flow through the call pipeline
      if (!m.body || !m.providerId) continue; // FACT: only real messages with an idempotency key
      const id = insertCommsEventIfNew({
        providerId: m.providerId,
        leadId: bookingId,
        direction: m.direction,
        channel: "sms",
        fromPhone: m.fromPhone,
        toPhone: m.toPhone,
        body: m.body,
        actor: m.actor,
        occurredAt: m.occurredAt,
      });
      if (id) inserted++; // null = duplicate (already stored) → no-op
    }
    return { inserted };
  } catch {
    return { inserted: 0 };
  }
}

export interface SyncActiveOpts {
  /** Max leads to sync in one run (default DEFAULT_LEAD_CAP). */
  cap?: number;
}

/** Sync the text threads of the active/open pipeline leads with a phone on file. Reuses the existing
 *  open-pipeline query (getPipelineLeads — read-only; it already excludes lost/cancelled/dead and past
 *  events), prioritizes still-open (unsigned) leads, and caps the set so we don't hammer the API. Each
 *  lead is synced sequentially (getCustomerTextThread already loops our Quo numbers per lead). Key-gated
 *  (no-op without an OpenPhone API key), bounded, and best-effort: one lead failing never aborts the run. */
export async function syncActiveLeadTextThreads(opts: SyncActiveOpts = {}): Promise<{ leads: number; inserted: number }> {
  if (!openphoneApiKey()) return { leads: 0, inserted: 0 }; // honest no-op when unconfigured
  const cap = opts.cap ?? DEFAULT_LEAD_CAP;

  let pipeline: BookingView[];
  try {
    pipeline = getPipelineLeads(todayInOpsTz());
  } catch {
    return { leads: 0, inserted: 0 };
  }

  // Only leads we can actually text, and prioritize the still-open ones (unsigned before signed wins).
  // getPipelineLeads is already date_created-desc, and Array.sort is stable, so within each group the
  // most recently created leads come first — the "most relevant" ones get synced before the cap bites.
  const picked = pipeline
    .filter((b) => last10(b.clientPhone))
    .sort((a, b) => Number(a.signed) - Number(b.signed))
    .slice(0, cap);

  let leads = 0;
  let inserted = 0;
  for (const b of picked) {
    try {
      const r = await syncLeadTextThread(b.bookingId, b.clientPhone);
      inserted += r.inserted;
      leads++;
    } catch {
      // Best-effort: a single lead's failure must never abort the rest of the run.
    }
  }
  return { leads, inserted };
}
