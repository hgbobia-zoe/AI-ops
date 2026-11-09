// Prospecting — PURCHASED CONTACT LISTS (venues, planners, corporate, associations) for Radar cold email.
// Owner (2026-11-08): besides the people Radar finds, Zoe buys lists of venues, planners and similar to
// cold email. Flow:
//   1. Import a list (CSV from Apollo, ZoomInfo, a list broker, ...). Common column names are mapped
//      automatically. Bad rows (no email, invalid email, duplicates in the file) are dropped and counted.
//   2. Every contact is screened on read with the same rules as the rest of Radar: the shared
//      do-not-contact list, Sales OS ownership (open Goodshuffle quote or recent customer), already handed
//      to the cold email tool from another list or from Radar outreach, and Zoe's own domain.
//   3. A person approves a push. Only eligible contacts go to the active cold email tool (Instantly by
//      default), into the list's own campaign (each segment gets its own copy) or the default campaign.
//      Instantly can verify emails first, which matters for bought data.
//   4. Replies are logged by a person. Not interested, bounced or unsubscribed lands on the do-not-contact
//      list. Interested becomes a Radar opportunity (stage Engaged), from where the existing intent-only
//      Convert to Goodshuffle takes over. Nothing here creates a Goodshuffle project.
// Cost per list is what Zoe paid (owner entered), for cost per reply and per interested lead. No guesses.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { insertAudit } from "@/lib/db/repo";
import { todayInOpsTz } from "@/lib/dates";
import { parseCsv } from "@/lib/opportunity/import";
import { upsertOpportunity, upsertEntity, linkEntity, setOpportunityStage } from "@/lib/opportunity/store";
import { normalizeJurisdiction } from "@/lib/opportunity/jurisdiction";
import type { EntityKind, RelationshipRole } from "@/lib/opportunity/types";
import { normalizeRegion } from "@/lib/radar/geo";
import { addSuppression, normalizeSuppressionValue } from "./store";
import { bookingKeepsContact } from "./contactOwnership";
import {
  activeProvider, providerApiKey, providerCampaignId, unsupportedProvider, validCampaignId, pushLeads, PROVIDER_LABEL,
  type FetchLike, type OutreachLead, type SequencerProvider,
} from "./sequencer";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Types ─────────────────────────────────────────────────────────────────────────────────────────
export type ListSegment = "venue" | "planner" | "corporate" | "association" | "other";
export const LIST_SEGMENTS: ListSegment[] = ["venue", "planner", "corporate", "association", "other"];
export const SEGMENT_LABEL: Record<ListSegment, string> = {
  venue: "Venues",
  planner: "Event planners",
  corporate: "Corporate / office managers",
  association: "Associations and nonprofits",
  other: "Other",
};
export const isListSegment = (v: unknown): v is ListSegment => typeof v === "string" && (LIST_SEGMENTS as string[]).includes(v);

export type ContactStatus = "new" | "pushed" | "skipped" | "replied" | "interested" | "not_interested" | "bounced" | "unsubscribed";
export const CONTACT_STATUS_LABEL: Record<ContactStatus, string> = {
  new: "Not sent",
  pushed: "In campaign",
  skipped: "Skipped by tool",
  replied: "Replied",
  interested: "Interested",
  not_interested: "Not interested",
  bounced: "Bounced",
  unsubscribed: "Unsubscribed",
};
/** Outcomes a person can log on a contact. */
export type ListOutcome = "replied" | "interested" | "not_interested" | "bounced" | "unsubscribed";
export const LIST_OUTCOMES: ListOutcome[] = ["replied", "interested", "not_interested", "bounced", "unsubscribed"];
const SUPPRESS_ON: Partial<Record<ListOutcome, string>> = {
  not_interested: "not interested (purchased list reply)",
  bounced: "bounced (purchased list)",
  unsubscribed: "unsubscribed (purchased list)",
};

export interface StoredList {
  id: string;
  name: string;
  segment: ListSegment;
  vendor: string | null;
  cost: number | null;
  purchasedAt: string | null;
  campaignId: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface ListContact {
  id: string;
  listId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  company: string | null;
  website: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  status: ContactStatus;
  skipReason: string | null;
  provider: string | null;
  pushedAt: string | null;
  pushedBy: string | null;
  outcomeBy: string | null;
  outcomeAt: string | null;
  opportunityId: string | null;
}

function toList(r: any): StoredList {
  return { id: r.id, name: r.name, segment: r.segment, vendor: r.vendor ?? null, cost: r.cost ?? null, purchasedAt: r.purchased_at ?? null, campaignId: r.campaign_id ?? null, notes: r.notes ?? null, createdBy: r.created_by ?? null, createdAt: r.created_at };
}
function toContact(r: any): ListContact {
  return {
    id: r.id, listId: r.list_id, email: r.email, firstName: r.first_name ?? null, lastName: r.last_name ?? null, title: r.title ?? null,
    company: r.company ?? null, website: r.website ?? null, phone: r.phone ?? null, city: r.city ?? null, state: r.state ?? null,
    status: r.status, skipReason: r.skip_reason ?? null, provider: r.provider ?? null, pushedAt: r.pushed_at ?? null, pushedBy: r.pushed_by ?? null,
    outcomeBy: r.outcome_by ?? null, outcomeAt: r.outcome_at ?? null, opportunityId: r.opportunity_id ?? null,
  };
}

// ── CSV mapping (PURE) ────────────────────────────────────────────────────────────────────────────
type Field = "email" | "first_name" | "last_name" | "full_name" | "title" | "company" | "website" | "phone" | "city" | "state";
/** Header aliases seen in list exports (Apollo, ZoomInfo, Seamless, brokers). Compared after lowercasing
 *  and collapsing punctuation to single spaces. First match wins, in this order. */
const ALIASES: Record<Field, string[]> = {
  email: ["email", "email address", "work email", "business email", "contact email", "e mail", "primary email", "corporate email"],
  first_name: ["first name", "firstname", "first", "contact first name", "given name"],
  last_name: ["last name", "lastname", "last", "contact last name", "surname", "family name"],
  full_name: ["name", "full name", "contact name", "contact", "person name"],
  title: ["title", "job title", "position", "role", "contact title"],
  company: ["company", "company name", "organization", "organization name", "account name", "business name", "venue", "venue name", "employer"],
  website: ["website", "company website", "domain", "company domain", "url", "web address", "website url"],
  phone: ["phone", "phone number", "direct phone", "work phone", "company phone", "mobile phone", "mobile", "corporate phone", "telephone"],
  city: ["city", "company city", "contact city", "person city"],
  state: ["state", "company state", "contact state", "person state", "region", "province", "state province"],
};
const normHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** PURE. Which source column feeds each field. */
export function mapColumns(headers: string[]): Partial<Record<Field, string>> {
  const byNorm = new Map<string, string>();
  for (const h of headers) if (!byNorm.has(normHeader(h))) byNorm.set(normHeader(h), h);
  const out: Partial<Record<Field, string>> = {};
  for (const f of Object.keys(ALIASES) as Field[]) {
    const hit = ALIASES[f].find((a) => byNorm.has(a));
    if (hit) out[f] = byNorm.get(hit);
  }
  return out;
}

export const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[a-z]{2,}$/i;
const OWN_DOMAINS = ["zoeeventsdmv.com"];
const clean = (s: string | undefined, max = 200): string | null => {
  const v = (s ?? "").trim().replace(/\s+/g, " ");
  return v ? v.slice(0, max) : null;
};

export interface ParsedContact {
  email: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  company: string | null;
  website: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
}

export interface ParseResult {
  contacts: ParsedContact[];
  rows: number;
  missingEmail: number;
  invalidEmail: number;
  duplicatesInFile: number;
  columns: Partial<Record<Field, string>>;
}

/** PURE. Parse a list CSV into contacts. Drops rows with no or invalid email, and repeats in the file. */
export function parseListCsv(csv: string): ParseResult {
  const rows = parseCsv(csv);
  const columns = rows.length ? mapColumns(Object.keys(rows[0])) : {};
  const out: ParseResult = { contacts: [], rows: rows.length, missingEmail: 0, invalidEmail: 0, duplicatesInFile: 0, columns };
  if (!columns.email) return out;
  // parseCsv lowercases + trims headers; the mapped names come from those same keys.
  const get = (r: Record<string, string>, f: Field) => (columns[f] ? r[columns[f]!] : undefined);
  const seen = new Set<string>();
  for (const r of rows) {
    const raw = (get(r, "email") ?? "").trim().replace(/^mailto:/i, "");
    const email = raw.split(/[;,\s]+/)[0]?.toLowerCase() ?? "";
    if (!email) { out.missingEmail++; continue; }
    if (!EMAIL_RE.test(email)) { out.invalidEmail++; continue; }
    if (seen.has(email)) { out.duplicatesInFile++; continue; }
    seen.add(email);
    let firstName = clean(get(r, "first_name"), 80);
    let lastName = clean(get(r, "last_name"), 80);
    if (!firstName && !lastName) {
      const full = clean(get(r, "full_name"), 160);
      if (full) {
        const parts = full.split(" ");
        firstName = parts[0];
        lastName = parts.length > 1 ? parts.slice(1).join(" ") : null;
      }
    }
    out.contacts.push({
      email, firstName, lastName,
      title: clean(get(r, "title"), 120),
      company: clean(get(r, "company"), 160),
      website: clean(get(r, "website"), 200),
      phone: clean(get(r, "phone"), 40),
      city: clean(get(r, "city"), 80),
      state: clean(get(r, "state"), 40),
    });
  }
  return out;
}

// ── Lists ─────────────────────────────────────────────────────────────────────────────────────────
export const MAX_LIST_ROWS = 25_000;

export interface ListInput {
  name: string;
  segment: ListSegment;
  vendor?: string | null;
  cost?: number | null;
  purchasedAt?: string | null;
  campaignId?: string | null;
  notes?: string | null;
}

/** Validate list fields. Returns an error message, or null when fine. */
export function validateListInput(i: Partial<ListInput>): string | null {
  if (!i.name || !i.name.trim()) return "give the list a name";
  if (!isListSegment(i.segment)) return "pick who is on the list (venues, planners, ...)";
  if (i.cost != null && (!Number.isFinite(i.cost) || i.cost < 0)) return "cost must be a dollar amount";
  if (i.purchasedAt && !/^\d{4}-\d{2}-\d{2}$/.test(i.purchasedAt)) return "purchase date must be YYYY-MM-DD";
  if (i.campaignId && !/^[0-9a-z-]{1,64}$/i.test(i.campaignId)) return "campaign id looks wrong";
  return null;
}

export interface ImportOutcome extends Omit<ParseResult, "contacts"> {
  list: StoredList;
  imported: number;
}

/** Create a list from a CSV. Throws on bad input (the caller maps it to a 400). */
export function importList(input: ListInput, csv: string, actor: string | null, now: Date = new Date()): ImportOutcome {
  const err = validateListInput(input);
  if (err) throw new Error(err);
  const parsed = parseListCsv(csv);
  if (parsed.rows === 0) throw new Error("no rows found; paste a CSV with a header row");
  if (!parsed.columns.email) throw new Error("no email column found (looked for email, work email, email address, ...)");
  if (parsed.rows > MAX_LIST_ROWS) throw new Error(`list too big (${parsed.rows} rows); split it into files of ${MAX_LIST_ROWS} or fewer`);
  if (parsed.contacts.length === 0) throw new Error("no usable emails in the file");

  const db = getDb();
  const ts = now.toISOString();
  const id = `LIST-${randomUUID()}`;
  const ins = db.prepare(
    `INSERT OR IGNORE INTO prospect_list_contacts (id, list_id, email, first_name, last_name, title, company, website, phone, city, state, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'new',?,?)`,
  );
  let imported = 0;
  db.transaction(() => {
    db.prepare("INSERT INTO prospect_lists (id, name, segment, vendor, cost, purchased_at, campaign_id, notes, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, input.name.trim().slice(0, 120), input.segment, input.vendor?.trim() || null, input.cost ?? null, input.purchasedAt || null, input.campaignId?.trim() || null, input.notes?.trim() || null, actor, ts, ts);
    for (const c of parsed.contacts) {
      imported += ins.run(`LC-${randomUUID()}`, id, c.email, c.firstName, c.lastName, c.title, c.company, c.website, c.phone, c.city, c.state, ts, ts).changes;
    }
  })();
  try {
    insertAudit({ actor: actor ?? "system", action: "prospecting.list_import", entity: "prospect_list", entityId: id, after: { name: input.name, segment: input.segment, imported, rows: parsed.rows } });
  } catch { /* audit is observability only */ }
  const { contacts: _drop, ...rest } = parsed;
  void _drop;
  return { ...rest, list: getList(id)!, imported };
}

export function getList(id: string): StoredList | null {
  const r = getDb().prepare("SELECT * FROM prospect_lists WHERE id=?").get(id);
  return r ? toList(r) : null;
}
export function getLists(): StoredList[] {
  return (getDb().prepare("SELECT * FROM prospect_lists ORDER BY created_at DESC").all() as any[]).map(toList);
}
export function updateList(id: string, patch: Partial<Omit<ListInput, "segment">> & { segment?: ListSegment }, now: Date = new Date()): StoredList | null {
  const cur = getList(id);
  if (!cur) return null;
  const next = {
    name: patch.name ?? cur.name, segment: patch.segment ?? cur.segment, vendor: patch.vendor !== undefined ? patch.vendor : cur.vendor,
    cost: patch.cost !== undefined ? patch.cost : cur.cost, purchasedAt: patch.purchasedAt !== undefined ? patch.purchasedAt : cur.purchasedAt,
    campaignId: patch.campaignId !== undefined ? patch.campaignId : cur.campaignId, notes: patch.notes !== undefined ? patch.notes : cur.notes,
  };
  const err = validateListInput(next);
  if (err) throw new Error(err);
  getDb().prepare("UPDATE prospect_lists SET name=?, segment=?, vendor=?, cost=?, purchased_at=?, campaign_id=?, notes=?, updated_at=? WHERE id=?")
    .run(next.name.trim(), next.segment, next.vendor?.trim() || null, next.cost ?? null, next.purchasedAt || null, next.campaignId?.trim() || null, next.notes?.trim() || null, now.toISOString(), id);
  return getList(id);
}
/** Delete a list imported by mistake. Refused once any contact was handed to the cold email tool, so
 *  the record of who was emailed is never lost. */
export function deleteList(id: string): { ok: boolean; error?: string } {
  const db = getDb();
  if (!getList(id)) return { ok: false, error: "not found" };
  const sent = db.prepare("SELECT COUNT(*) AS n FROM prospect_list_contacts WHERE list_id=? AND pushed_at IS NOT NULL").get(id) as { n: number };
  if (sent.n > 0) return { ok: false, error: `${sent.n} contacts were already sent to the cold email tool; the list is kept as the record` };
  db.transaction(() => {
    db.prepare("DELETE FROM prospect_list_contacts WHERE list_id=?").run(id);
    db.prepare("DELETE FROM prospect_lists WHERE id=?").run(id);
  })();
  return { ok: true };
}

export function getListContacts(listId: string): ListContact[] {
  return (getDb().prepare("SELECT * FROM prospect_list_contacts WHERE list_id=? ORDER BY company COLLATE NOCASE, email").all(listId) as any[]).map(toContact);
}
export function getListContact(id: string): ListContact | null {
  const r = getDb().prepare("SELECT * FROM prospect_list_contacts WHERE id=?").get(id);
  return r ? toContact(r) : null;
}

// ── Screening ─────────────────────────────────────────────────────────────────────────────────────
/** Everything the screen needs, loaded once (a list can be thousands of contacts). */
export interface ScreenIndex {
  suppressed: { email: Set<string>; domain: Set<string>; company: Set<string>; phone: Set<string> };
  salesOs: { email: Set<string>; phone: Set<string> };
  /** email → where it was already handed to the cold email tool ("list <name>" / "Radar outreach"). */
  sentElsewhere: Map<string, { listId: string | null; label: string }>;
}

const last10 = (p: string | null | undefined) => (p ?? "").replace(/\D/g, "").slice(-10);

export function buildScreenIndex(today: string = todayInOpsTz()): ScreenIndex {
  const db = getDb();
  const suppressed = { email: new Set<string>(), domain: new Set<string>(), company: new Set<string>(), phone: new Set<string>() };
  for (const r of db.prepare("SELECT kind, value FROM prospect_suppression").all() as { kind: string; value: string }[]) {
    if (r.kind in suppressed) suppressed[r.kind as keyof typeof suppressed].add(r.value);
  }
  const salesOs = { email: new Set<string>(), phone: new Set<string>() };
  const bookings = db.prepare("SELECT client_email, client_phone, signed, archived, event_date, status_label FROM bookings").all() as {
    client_email: string | null; client_phone: string | null; signed: number | null; archived: number | null; event_date: string | null; status_label: string | null;
  }[];
  for (const b of bookings) {
    if (!bookingKeepsContact(b, today)) continue;
    const e = b.client_email?.trim().toLowerCase();
    if (e) salesOs.email.add(e);
    const p = last10(b.client_phone);
    if (p.length === 10) salesOs.phone.add(p);
  }
  const sentElsewhere = new Map<string, { listId: string | null; label: string }>();
  for (const r of db.prepare("SELECT c.email, c.list_id, l.name FROM prospect_list_contacts c JOIN prospect_lists l ON l.id = c.list_id WHERE c.pushed_at IS NOT NULL").all() as { email: string; list_id: string; name: string }[]) {
    if (!sentElsewhere.has(r.email)) sentElsewhere.set(r.email, { listId: r.list_id, label: `list "${r.name}"` });
  }
  for (const r of db.prepare("SELECT lower(trim(e.email)) AS email FROM prospect_enrollments p JOIN radar_entities e ON e.id = p.entity_id WHERE p.sequencer_pushed_at IS NOT NULL AND e.email IS NOT NULL").all() as { email: string }[]) {
    if (r.email && !sentElsewhere.has(r.email)) sentElsewhere.set(r.email, { listId: null, label: "Radar outreach" });
  }
  return { suppressed, salesOs, sentElsewhere };
}

/** PURE given the index. Why a NEW contact can't be sent (empty = eligible). */
export function screenContact(c: Pick<ListContact, "email" | "company" | "phone" | "listId">, idx: ScreenIndex): string[] {
  const out: string[] = [];
  const email = c.email.toLowerCase();
  const domain = email.split("@")[1] ?? "";
  if (!EMAIL_RE.test(email)) out.push("email address looks invalid");
  if (OWN_DOMAINS.includes(domain)) out.push("Zoe's own address");
  const company = c.company ? normalizeSuppressionValue("company", c.company) : "";
  const phone = last10(c.phone);
  if (idx.suppressed.email.has(email) || idx.suppressed.domain.has(domain) || (company && idx.suppressed.company.has(company)) || (phone.length === 10 && idx.suppressed.phone.has(phone))) {
    out.push("on the do-not-contact list");
  }
  if (idx.salesOs.email.has(email) || (phone.length === 10 && idx.salesOs.phone.has(phone))) out.push("Sales OS owns this contact (open quote or recent customer)");
  const sent = idx.sentElsewhere.get(email);
  if (sent && sent.listId !== c.listId) out.push(`already emailed from ${sent.label}`);
  return out;
}

export interface ScreenedContact extends ListContact {
  blockers: string[];
  eligible: boolean;
}

/** Contacts of a list with their screen. Only status "new" can be eligible. */
export function screenedContacts(listId: string, idx: ScreenIndex = buildScreenIndex()): ScreenedContact[] {
  return getListContacts(listId).map((c) => {
    const blockers = c.status === "new" ? screenContact(c, idx) : [];
    return { ...c, blockers, eligible: c.status === "new" && blockers.length === 0 };
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────────────────────────────
export interface ListStats {
  total: number;
  ready: number;
  blocked: number;
  pushed: number;
  skipped: number;
  replied: number;
  interested: number;
  negative: number;
  opportunities: number;
  converted: number;
  costPerContact: number | null;
  costPerReply: number | null;
  costPerInterested: number | null;
}

/** PURE. Funnel numbers for one list. Replied counts every reply (interested and not interested too). */
export function listStats(list: Pick<StoredList, "cost">, contacts: ScreenedContact[], convertedOpportunityIds: Set<string>): ListStats {
  const n = (f: (c: ScreenedContact) => boolean) => contacts.filter(f).length;
  const total = contacts.length;
  const replied = n((c) => c.status === "replied" || c.status === "interested" || c.status === "not_interested" || c.status === "unsubscribed");
  const interested = n((c) => c.status === "interested");
  const per = (d: number) => (list.cost != null && d > 0 ? Math.round((list.cost / d) * 100) / 100 : null);
  return {
    total,
    ready: n((c) => c.eligible),
    blocked: n((c) => c.status === "new" && !c.eligible),
    pushed: n((c) => c.pushedAt != null),
    skipped: n((c) => c.status === "skipped"),
    replied,
    interested,
    negative: n((c) => c.status === "not_interested" || c.status === "bounced" || c.status === "unsubscribed"),
    opportunities: n((c) => c.opportunityId != null),
    converted: n((c) => c.opportunityId != null && convertedOpportunityIds.has(c.opportunityId)),
    costPerContact: per(total),
    costPerReply: per(replied),
    costPerInterested: per(interested),
  };
}

/** Radar opportunities already converted to Goodshuffle (intent confirmed). */
export function convertedOpportunityIds(): Set<string> {
  return new Set((getDb().prepare("SELECT id FROM opportunities WHERE converted_at IS NOT NULL").all() as { id: string }[]).map((r) => r.id));
}

export interface ListSummary { list: StoredList; stats: ListStats }
export function listSummaries(): ListSummary[] {
  const idx = buildScreenIndex();
  const conv = convertedOpportunityIds();
  return getLists().map((list) => ({ list, stats: listStats(list, screenedContacts(list.id, idx), conv) }));
}

// ── Push (human approved) ─────────────────────────────────────────────────────────────────────────
export const MAX_PUSH = 500;

export interface ListPushOutcome {
  ok: boolean;
  provider: string;
  campaignId: string | null;
  approved: number;
  added: number;
  skipped: { email: string; reason: string }[];
  errors: string[];
}

/** Which campaign a list's contacts go to: its own, else the tool's default. */
export function listCampaign(list: StoredList, provider: SequencerProvider = activeProvider()): string | null {
  return list.campaignId || providerCampaignId(provider);
}

/** Push the approved contacts of one list. Re-screens first so nothing stale goes out; at most
 *  MAX_PUSH per call. Accepted contacts are marked pushed; ones the tool skipped are marked skipped with
 *  the reason; failed calls leave them as they were. */
export async function pushListContacts(
  listId: string,
  contactIds: string[],
  actor: string,
  opts: { verify?: boolean; fetchImpl?: FetchLike } = {},
  now: Date = new Date(),
): Promise<ListPushOutcome> {
  const provider = activeProvider();
  const label = PROVIDER_LABEL[provider];
  const list = getList(listId);
  const out: ListPushOutcome = { ok: true, provider: label, campaignId: null, approved: contactIds.length, added: 0, skipped: [], errors: [] };
  if (!list) return { ...out, ok: false, errors: ["list not found"] };
  const bad = unsupportedProvider();
  if (bad) return { ...out, ok: false, errors: [`SEQUENCER_PROVIDER=${bad} is not supported; pick Instantly or Smartlead in the outreach settings`] };
  const key = providerApiKey(provider);
  const campaignId = listCampaign(list, provider);
  out.campaignId = campaignId;
  if (!key || !campaignId) return { ...out, ok: false, errors: [`${label} is not connected (API key and a campaign for this list or a default one)`] };
  if (!validCampaignId(provider, campaignId)) return { ...out, ok: false, errors: [`the campaign id for this list isn't a valid ${label} campaign id`] };
  if (contactIds.length > MAX_PUSH) return { ...out, ok: false, errors: [`push at most ${MAX_PUSH} at a time`] };

  const wanted = new Set(contactIds);
  const screened = screenedContacts(listId).filter((c) => wanted.has(c.id));
  for (const id of wanted) if (!screened.some((c) => c.id === id)) out.skipped.push({ email: id, reason: "not in this list" });
  const eligible = screened.filter((c) => {
    if (!c.eligible) out.skipped.push({ email: c.email, reason: c.status !== "new" ? `already ${CONTACT_STATUS_LABEL[c.status].toLowerCase()}` : c.blockers.join("; ") });
    return c.eligible;
  });
  if (eligible.length === 0) return out;

  const leads: OutreachLead[] = eligible.map((c) => ({
    email: c.email,
    firstName: c.firstName ?? undefined,
    lastName: c.lastName ?? undefined,
    phone: c.phone ?? undefined,
    company: c.company ?? undefined,
    website: c.website ?? undefined,
    location: [c.city, c.state].filter(Boolean).join(", ") || undefined,
    vars: { segment: SEGMENT_LABEL[list.segment], title: c.title ?? "", city: c.city ?? "", list: list.name },
  }));
  const res = await pushLeads(provider, leads, { key, campaignId, fetchImpl: opts.fetchImpl, verify: opts.verify });
  out.ok = res.ok;
  out.errors.push(...res.errors);
  const skippedSet = new Set(res.skippedEmails);
  const failedSet = new Set(res.failedEmails);
  const skipReason = provider === "instantly" ? "Instantly skipped it (blocklist, invalid email, or already in your Instantly workspace)" : "Smartlead skipped it (block, unsubscribe, bounce or duplicate list)";
  const db = getDb();
  const ts = now.toISOString();
  const markPushed = db.prepare("UPDATE prospect_list_contacts SET status='pushed', provider=?, pushed_at=?, pushed_by=?, skip_reason=NULL, updated_at=? WHERE id=?");
  const markSkipped = db.prepare("UPDATE prospect_list_contacts SET status='skipped', provider=?, skip_reason=?, updated_at=? WHERE id=?");
  db.transaction(() => {
    for (const c of eligible) {
      if (failedSet.has(c.email)) { out.skipped.push({ email: c.email, reason: `${label} call failed; try again` }); continue; }
      if (skippedSet.has(c.email)) { markSkipped.run(provider, skipReason, ts, c.id); out.skipped.push({ email: c.email, reason: skipReason }); continue; }
      markPushed.run(provider, ts, actor, ts, c.id);
      out.added++;
    }
  })();
  try {
    insertAudit({ actor, action: "prospecting.list_push", entity: "prospect_list", entityId: listId, after: { provider, campaignId, approved: contactIds.length, added: out.added, skipped: out.skipped.length, verify: Boolean(opts.verify) } });
  } catch { /* audit is observability only */ }
  return out;
}

// ── Outcomes ──────────────────────────────────────────────────────────────────────────────────────
const SEGMENT_ENTITY: Record<ListSegment, { kind: EntityKind; role: RelationshipRole }> = {
  venue: { kind: "PARTNER", role: "PARTNER" },
  planner: { kind: "EVENT_PLANNER", role: "EVENT_PLANNER" },
  corporate: { kind: "CONTACT", role: "DIRECT_BUYER" },
  association: { kind: "CONTACT", role: "DIRECT_BUYER" },
  other: { kind: "CONTACT", role: "UNKNOWN" },
};

export interface OutcomeResult { ok: boolean; contact?: ListContact; opportunityId?: string | null; error?: string }

/** Log what came back from a contact. Negative outcomes go on the shared do-not-contact list.
 *  "interested" also creates (once) a Radar opportunity at stage Engaged, linked to the contact as its
 *  primary target, so the team can convert it to Goodshuffle with the existing intent-confirmed flow. */
export function logListOutcome(contactId: string, outcome: ListOutcome, actor: string, now: Date = new Date()): OutcomeResult {
  if (!LIST_OUTCOMES.includes(outcome)) return { ok: false, error: "unknown outcome" };
  const c = getListContact(contactId);
  if (!c) return { ok: false, error: "not found" };
  const list = getList(c.listId);
  if (!list) return { ok: false, error: "list not found" };
  const db = getDb();
  const ts = now.toISOString();
  db.prepare("UPDATE prospect_list_contacts SET status=?, outcome_by=?, outcome_at=?, updated_at=? WHERE id=?").run(outcome, actor, ts, ts, contactId);
  const reason = SUPPRESS_ON[outcome];
  if (reason) addSuppression("email", c.email, reason, actor, now);

  let opportunityId = c.opportunityId;
  if (outcome === "interested" && !opportunityId) {
    const person = [c.firstName, c.lastName].filter(Boolean).join(" ");
    const org = c.company || person || c.email;
    const region = normalizeRegion({ city: c.city, state: c.state });
    const opp = upsertOpportunity({
      dedupeKey: `list:${c.id}`,
      kind: "EVENT",
      name: `${org}: interested reply`,
      description: `Replied with interest to cold email from the purchased list "${list.name}" (${SEGMENT_LABEL[list.segment]}). Contact: ${[person, c.title, c.email, c.phone].filter(Boolean).join(", ")}.`,
      sourceName: `Purchased list: ${list.name}`,
      jurisdiction: normalizeJurisdiction({ text: [c.city, c.state].filter(Boolean).join(" "), region }),
      region,
      city: c.city,
      state: c.state,
      organization: c.company,
      verificationStatus: "VERIFIED",
      recommendedAction: "Call or reply to qualify the need, then convert to Goodshuffle once they ask for a quote.",
    }, now);
    const m = SEGMENT_ENTITY[list.segment];
    const entity = upsertEntity({
      name: c.company || person || c.email, kind: m.kind, website: c.website, email: c.email, phone: c.phone, jurisdiction: null,
      verificationStatus: "VERIFIED", matchedCustomerKey: null, notes: person ? `${person}${c.title ? `, ${c.title}` : ""}` : null, isSeed: false,
    }, now);
    linkEntity(opp.id, entity.id, m.role, { isPrimaryTarget: true, evidence: `Interested reply, purchased list "${list.name}"` }, now);
    setOpportunityStage(opp.id, "ENGAGED", now);
    opportunityId = opp.id;
    db.prepare("UPDATE prospect_list_contacts SET opportunity_id=?, updated_at=? WHERE id=?").run(opportunityId, ts, contactId);
  }
  try {
    insertAudit({ actor, action: "prospecting.list_outcome", entity: "prospect_list_contact", entityId: contactId, after: { outcome, email: c.email, listId: c.listId, opportunityId } });
  } catch { /* audit is observability only */ }
  return { ok: true, contact: getListContact(contactId)!, opportunityId };
}

/** CSV template for a list import (the common columns; extra columns are ignored). */
export const LIST_TEMPLATE = "email,first_name,last_name,title,company,website,phone,city,state\nevents@examplevenue.com,Jordan,Lee,Events Director,Example Venue,examplevenue.com,(301) 555-0100,Bethesda,MD";
/* eslint-enable @typescript-eslint/no-explicit-any */
