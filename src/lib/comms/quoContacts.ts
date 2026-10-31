// Quo (OpenPhone) contact de-duplication — the I/O half. Pages the whole address book through the public
// API, builds the duplicate report (rules in quoContactsDedupe.ts), and merges ONE group per call:
//
//   1. re-fetch every member fresh by id (the report may be minutes old; a member may already be gone),
//   2. re-check the members still form exactly one duplicate group (the endpoint can't merge strangers),
//   3. PATCH the survivor with the complete merged phone/email/custom-field lists (Quo REPLACES, so
//      partial lists would wipe data),
//   4. GET the survivor back and confirm it holds every phone + email from the group,
//   5. write an audit row holding the FULL JSON of every member (the backup: a deleted contact can be
//      re-created from it), and only then
//   6. DELETE the other members.
//
// Any failure before step 6 deletes nothing. Deleting a contact does not delete call or text history in
// Quo (that history belongs to the phone number, not the contact card). Rate limit is 10 req/s per key;
// calls are spaced to ~8/s with retry on 429.

import { openphoneApiKey } from "@/lib/comms/openphone";
import { insertAudit } from "@/lib/db/repo";
import {
  buildMergePatch,
  dedupeStats,
  displayName,
  emailsOf,
  findDuplicateGroups,
  formsOneGroup,
  missingAfterMerge,
  phonesOf,
  type DedupeStats,
  type DuplicateGroup,
  type QuoContact,
} from "@/lib/comms/quoContactsDedupe";

const BASE = "https://api.openphone.com/v1";
const MIN_GAP_MS = 125;
const MAX_PAGES = 2000; // 100k contacts at 50/page — far above any real address book
export const MAX_GROUP_SIZE = 25;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastCallAt = 0;

async function quo(method: string, path: string, apiKey: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = lastCallAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body === undefined ? { authorization: apiKey } : { authorization: apiKey, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    const json = res.status === 204 ? null : ((await res.json().catch(() => null)) as Record<string, unknown> | null);
    return { status: res.status, json };
  }
  return { status: 429, json: null };
}

export class QuoNotConfiguredError extends Error {
  constructor() {
    super("Quo API key is not configured");
  }
}

function requireKey(): string {
  const key = openphoneApiKey();
  if (!key) throw new QuoNotConfiguredError();
  return key;
}

/** Every contact in the Quo workspace (50 per page). Throws on an API error so a partial address book is
 *  never reported as the whole thing. */
export async function listAllQuoContacts(): Promise<QuoContact[]> {
  const apiKey = requireKey();
  const all: QuoContact[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = `/contacts?maxResults=50${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const { status, json } = await quo("GET", q, apiKey);
    if (status !== 200 || !json) throw new Error(`Quo contacts list failed (HTTP ${status})`);
    const data = (json.data as QuoContact[]) ?? [];
    all.push(...data.filter((c) => c?.id));
    pageToken = (json.nextPageToken as string) ?? null;
    if (!pageToken || data.length === 0) break;
  }
  return all;
}

async function getQuoContact(id: string, apiKey: string): Promise<QuoContact | null> {
  const { status, json } = await quo("GET", `/contacts/${encodeURIComponent(id)}`, apiKey);
  if (status === 404) return null;
  if (status !== 200 || !json?.data) throw new Error(`Quo contact ${id} fetch failed (HTTP ${status})`);
  return json.data as QuoContact;
}

// ── Report ───────────────────────────────────────────────────────────────────────────────────────────

export interface ReportContact {
  id: string;
  name: string;
  company: string;
  phones: string[];
  emails: string[];
  createdAt: string | null;
  source: string | null;
  survivor: boolean;
}

export interface ReportGroup extends Omit<DuplicateGroup, "contactIds"> {
  contacts: ReportContact[];
}

export interface DedupeReport {
  fetchedAt: string;
  stats: DedupeStats;
  groups: ReportGroup[];
}

let reportCache: { at: number; report: DedupeReport } | null = null;
const REPORT_TTL_MS = 10 * 60 * 1000;

export function invalidateQuoDedupeReport(): void {
  reportCache = null;
}

export function toReport(contacts: QuoContact[], fetchedAt: string): DedupeReport {
  const groups = findDuplicateGroups(contacts);
  const byId = new Map(contacts.map((c) => [c.id, c]));
  return {
    fetchedAt,
    stats: dedupeStats(contacts, groups),
    groups: groups.map(({ contactIds, ...g }) => ({
      ...g,
      contacts: contactIds
        .map((id) => byId.get(id)!)
        .map((c) => ({
          id: c.id,
          name: displayName(c),
          company: String(c.defaultFields?.company ?? "").trim(),
          phones: phonesOf(c),
          emails: emailsOf(c),
          createdAt: c.createdAt ?? null,
          source: c.source ?? null,
          survivor: c.id === g.survivorId,
        }))
        .sort((a, b) => Number(b.survivor) - Number(a.survivor) || String(a.createdAt).localeCompare(String(b.createdAt))),
    })),
  };
}

/** The duplicate report, cached 10 min (paging a large address book takes a while). `refresh` forces a
 *  fresh pull. */
export async function getQuoDedupeReport(refresh = false): Promise<DedupeReport> {
  if (!refresh && reportCache && Date.now() - reportCache.at < REPORT_TTL_MS) return reportCache.report;
  const contacts = await listAllQuoContacts();
  const report = toReport(contacts, new Date().toISOString());
  reportCache = { at: Date.now(), report };
  return report;
}

// ── Merge ────────────────────────────────────────────────────────────────────────────────────────────

export type MergeOutcome =
  | { ok: true; survivorId: string; deletedIds: string[]; skippedIds: string[] }
  | { ok: false; reason: string; detail?: unknown };

export async function mergeQuoContacts(
  contactIds: string[],
  opts: { actor: string; confirmReview?: boolean },
): Promise<MergeOutcome> {
  const ids = [...new Set(contactIds.map(String).filter(Boolean))];
  if (ids.length < 2) return { ok: false, reason: "Pick at least two contacts to merge." };
  if (ids.length > MAX_GROUP_SIZE) return { ok: false, reason: `A group can have at most ${MAX_GROUP_SIZE} contacts.` };
  const apiKey = requireKey();

  // 1. Fresh copies. A member deleted since the report is skipped, not an error.
  const fresh: QuoContact[] = [];
  const skippedIds: string[] = [];
  for (const id of ids) {
    const c = await getQuoContact(id, apiKey);
    if (c) fresh.push(c);
    else skippedIds.push(id);
  }
  if (fresh.length < 2) {
    invalidateQuoDedupeReport();
    return { ok: false, reason: "These contacts were already merged or deleted. Refresh the list." };
  }

  // 2. Still one group, and confidence rules respected.
  const group = formsOneGroup(fresh, fresh.map((c) => c.id));
  if (!group) return { ok: false, reason: "These contacts no longer share a phone number or email. Refresh the list." };
  if (group.confidence === "review" && !opts.confirmReview) {
    return { ok: false, reason: "These contacts carry different names. Confirm they are the same person to merge them." };
  }

  const survivor = fresh.find((c) => c.id === group.survivorId)!;
  const others = fresh.filter((c) => c.id !== survivor.id);
  const patch = buildMergePatch(survivor, others);

  // 3. Update the survivor.
  const upd = await quo("PATCH", `/contacts/${encodeURIComponent(survivor.id)}`, apiKey, patch);
  if (upd.status < 200 || upd.status >= 300) {
    return { ok: false, reason: `Quo refused the update (HTTP ${upd.status}). Nothing was deleted.`, detail: upd.json };
  }

  // 4. Verify before deleting anything.
  const after = await getQuoContact(survivor.id, apiKey);
  if (!after) return { ok: false, reason: "The kept contact could not be read back. Nothing was deleted." };
  const missing = missingAfterMerge(after, fresh);
  if (missing.phones.length || missing.emails.length) {
    return { ok: false, reason: "The kept contact is missing some details after the update. Nothing was deleted.", detail: missing };
  }

  // 5. Backup (full JSON of every member) BEFORE the deletes.
  insertAudit({
    actor: opts.actor,
    action: "QUO_CONTACT_MERGE",
    entity: "quo_contact",
    entityId: survivor.id,
    before: { contacts: fresh },
    after: { survivor: after, patch, deleteIds: others.map((c) => c.id), confidence: group.confidence },
  });

  // 6. Delete the duplicates. A failed delete is reported; the merged survivor already holds its details.
  const deletedIds: string[] = [];
  const failed: { id: string; status: number }[] = [];
  for (const c of others) {
    const del = await quo("DELETE", `/contacts/${encodeURIComponent(c.id)}`, apiKey);
    if (del.status === 204 || del.status === 200 || del.status === 404) deletedIds.push(c.id);
    else failed.push({ id: c.id, status: del.status });
  }
  invalidateQuoDedupeReport();
  if (failed.length) {
    insertAudit({ actor: opts.actor, action: "QUO_CONTACT_MERGE_DELETE_FAILED", entity: "quo_contact", entityId: survivor.id, after: { failed } });
    return { ok: false, reason: `Merged into the kept contact, but ${failed.length} duplicate(s) could not be deleted. Try again.`, detail: { failed, deletedIds } };
  }
  return { ok: true, survivorId: survivor.id, deletedIds, skippedIds };
}
