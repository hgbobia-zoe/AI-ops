// Instawork worker-contact store. The gig-groups PULL (snapshot, see store.ts) carries worker_id + name but
// NOT a phone. The booked-pro phone IS exposed by a SEPARATE Instawork endpoint —
//   GET /api/partner/shifts/timesheet-v2/shift-group/<groupId>
//     → { shifts: [{ worker_id, worker, worker_phone_number, ... }] }
// (confirmed live 2026-10-16: shifts[].worker_phone_number = the booked pro's real number) — which the
// Auto-Pull browser extension fetches per BOOKED group inside the operator's logged-in session and POSTs to
// /api/instawork/contacts. We persist a worker → phone map HERE so a shift debrief can actually reach an
// Instawork worker (previously honestly skipped as "contact not captured"). The Zoe server NEVER calls
// Instawork — it only reads this stored map. Persisted in the settings KV, mirroring store.ts. Never throws.

import { getDb } from "@/lib/db";

const KEY = "instawork.contacts";

/** Keep the map bounded. Phones rarely change, so we retain a long tail (contacts captured weeks ago stay
 *  usable) but cap the row count so the KV value can't grow without limit. Oldest-captured are pruned first. */
export const MAX_CONTACTS = 4000;

export interface InstaworkContact {
  /** Instawork numeric worker id (stable), as a string. Null only if a row somehow lacked it. */
  workerId: string | null;
  /** Worker display name — the handle our ShiftAssignment carries (instaworkWorker). */
  name: string;
  /** Phone exactly as Instawork shows it, e.g. "(301) 555-0147". Normalized to E.164 at send (notify/sms). */
  phone: string;
  /** ISO of when this contact was last captured. */
  capturedAt: string;
}

export interface InstaworkContactStore {
  contacts: InstaworkContact[];
  updatedAt: string;
}

const nameKey = (s: string): string => s.trim().toLowerCase();
const digitsOf = (s: string): string => (s || "").replace(/\D/g, "");

/** A phone string plausibly dialable (US 10-digit or 1+10). Keeps junk/partial strings out of the store;
 *  final E.164 coercion still happens in notify/sms.toE164 at send time. */
export function plausiblePhone(raw: string): boolean {
  const d = digitsOf(raw);
  return d.length === 10 || (d.length === 11 && d.startsWith("1"));
}

/** Map one raw timesheet-v2 shift row to a contact, or null when it lacks a usable phone or any identity.
 *  Defensive: Instawork may add/rename fields; only the three we need are read. */
export function toContact(r: Record<string, unknown>, capturedAt: string): InstaworkContact | null {
  const phoneRaw = typeof r.worker_phone_number === "string" ? r.worker_phone_number.trim() : "";
  if (!phoneRaw || !plausiblePhone(phoneRaw)) return null;
  const name = typeof r.worker === "string" ? r.worker.trim() : "";
  const workerId = r.worker_id != null && String(r.worker_id).trim() ? String(r.worker_id).trim() : null;
  if (!name && !workerId) return null; // nothing to key a lookup on
  return { workerId, name, phone: phoneRaw, capturedAt };
}

/** The dedup key: worker id when present (stable), else the normalized name. */
function keyOf(c: InstaworkContact): string {
  return c.workerId ? `id:${c.workerId}` : `nm:${nameKey(c.name)}`;
}

function read(): InstaworkContactStore {
  try {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    if (!row) return { contacts: [], updatedAt: "" };
    const parsed = JSON.parse(row.value) as InstaworkContactStore;
    if (!parsed || !Array.isArray(parsed.contacts)) return { contacts: [], updatedAt: "" };
    return parsed;
  } catch {
    return { contacts: [], updatedAt: "" };
  }
}

/** Merge freshly captured contacts into the stored map (newest wins per worker), keeping the most-recently
 *  captured MAX_CONTACTS. Returns the stored count after the merge. Never throws. */
export function saveInstaworkContacts(incoming: InstaworkContact[]): number {
  try {
    const now = new Date().toISOString();
    const map = new Map<string, InstaworkContact>();
    for (const c of read().contacts) map.set(keyOf(c), c);
    for (const c of incoming) map.set(keyOf(c), c); // freshly captured overrides the stored copy
    let contacts = [...map.values()].sort((a, b) => (b.capturedAt || "").localeCompare(a.capturedAt || ""));
    if (contacts.length > MAX_CONTACTS) contacts = contacts.slice(0, MAX_CONTACTS);
    getDb()
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(KEY, JSON.stringify({ contacts, updatedAt: now } satisfies InstaworkContactStore), now);
    return contacts.length;
  } catch {
    return 0;
  }
}

/** The full stored map (for health/visibility). Synchronous. */
export function readInstaworkContacts(): InstaworkContactStore {
  return read();
}

/** The captured phone for an Instawork worker, matched by id (preferred, stable) then name
 *  (case-insensitive) — mirroring reconcile.findGigForWorker. Returns null when not captured. */
export function findInstaworkPhone(opts: { workerName?: string | null; workerId?: string | null }): string | null {
  const id = (opts.workerId ?? "").trim();
  const name = nameKey(opts.workerName ?? "");
  if (!id && !name) return null;
  const { contacts } = read();
  if (id) {
    for (const c of contacts) if (c.workerId && c.workerId === id) return c.phone;
  }
  if (name) {
    for (const c of contacts) if (nameKey(c.name) === name) return c.phone;
  }
  return null;
}
