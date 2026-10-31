// Quo (OpenPhone) contact de-duplication — the PURE half (no fetch, no DB) so every rule is unit-testable.
// The I/O half (paging the API, PATCH/DELETE, the audit backup) lives in quoContacts.ts.
//
// Why duplicates exist: Zapier's Quo "Create/Update Contact" action creates a NEW contact on every run
// unless an ID is mapped, so years of form/lead Zaps left the same customer saved many times.
//
// Rules (deterministic, conservative):
//  - Two contacts are LINKED when they share a phone number (compared on the last 10 digits) or an email
//    (case-insensitive). Links are transitive (union-find), so A~B and B~C form one group.
//  - A group is "exact" when every contact that HAS a name carries the same name (blank names are fine:
//    a bare number saved next to the named customer is the classic Zap duplicate). Only exact groups are
//    offered for bulk merge.
//  - A group whose contacts carry DIFFERENT names is "review": a shared office line or a couple sharing a
//    phone looks like this. It is shown, never bulk-merged, and needs an explicit per-group confirm.
//  - Name-only matches (same name, nothing shared) are NOT grouped — two "John Smith"s can be different
//    people, and there is no contact detail to prove otherwise.
//  - HUB keys never link contacts: Zoe's own addresses (old Zaps stamped hello@/admin@ and the
//    Squarespace form sender onto customers) and any phone/email carried by 3+ different names. Without
//    this one shared office address chained 166 unrelated customers into one "group" (live, 2026-10-31).
//  - A merge is DELETE-ONLY: the kept contact must already hold every phone, email, company, role and
//    custom-field value in the group, so nothing is ever written to it. Groups that would need details
//    copied over are flagged for a hand merge in Quo. Why: Quo's PATCH wiped both the phone and the email
//    of a HubSpot-synced contact during the first live merge (2026-10-31), even with the full lists sent.

export interface QuoField {
  name: string;
  value: string | null;
  id?: string;
}

export interface QuoCustomField {
  name?: string;
  key?: string;
  id?: string;
  type?: string;
  value?: unknown;
}

export interface QuoContact {
  id: string;
  externalId?: string | null;
  source?: string | null;
  sourceUrl?: string | null;
  defaultFields?: {
    firstName?: string | null;
    lastName?: string | null;
    company?: string | null;
    role?: string | null;
    emails?: QuoField[] | null;
    phoneNumbers?: QuoField[] | null;
  } | null;
  customFields?: QuoCustomField[] | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  createdByUserId?: string | null;
}

export type Confidence = "exact" | "review";

export interface DuplicateGroup {
  /** Stable id for the group: the sorted member ids joined. */
  key: string;
  contactIds: string[];
  confidence: Confidence;
  /** Plain-language reason shown on the card. */
  reason: string;
  sharedPhones: string[]; // last-10 digits shared by 2+ members
  sharedEmails: string[]; // lowercased emails shared by 2+ members
  names: string[]; // distinct display names in the group
  survivorId: string;
  /** True when the kept contact already holds everything, so merging only deletes the copies. */
  deleteOnly: boolean;
  /** What the kept contact lacks (empty when deleteOnly). Shown so the team can merge it by hand. */
  keptLacks: string[];
}

// ── Normalizers ──────────────────────────────────────────────────────────────────────────────────────

/** Last 10 digits of a phone number, or null when it has fewer than 10 digits. "+1 (301) 555-0101",
 *  "301.555.0101" and "13015550101" all normalize to "3015550101". */
export function phoneKey(v: string | null | undefined): string | null {
  const d = String(v ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
}

export function emailKey(v: string | null | undefined): string | null {
  const s = String(v ?? "").trim().toLowerCase();
  return s.includes("@") ? s : null;
}

function clean(v: string | null | undefined): string {
  return String(v ?? "").trim();
}

export function displayName(c: QuoContact): string {
  const f = c.defaultFields ?? {};
  const full = [clean(f.firstName), clean(f.lastName)].filter(Boolean).join(" ");
  return full || clean(f.company);
}

/** Comparison key for a person's name: letters only, lowercased, so "Pat  Smith" == "pat smith". Empty
 *  when the contact has no first/last name (company-only contacts compare on company). */
export function nameKey(c: QuoContact): string {
  return displayName(c).toLowerCase().replace(/[^a-z]/g, "");
}

export function phonesOf(c: QuoContact): string[] {
  const out: string[] = [];
  for (const p of c.defaultFields?.phoneNumbers ?? []) {
    const k = phoneKey(p?.value);
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

export function emailsOf(c: QuoContact): string[] {
  const out: string[] = [];
  for (const e of c.defaultFields?.emails ?? []) {
    const k = emailKey(e?.value);
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

function hasValue(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

// ── Grouping ─────────────────────────────────────────────────────────────────────────────────────────

/** How much a contact carries. The richest contact survives a merge so the least data moves. */
export function completeness(c: QuoContact): number {
  const f = c.defaultFields ?? {};
  let n = 0;
  for (const v of [f.firstName, f.lastName, f.company, f.role]) if (clean(v)) n++;
  n += phonesOf(c).length + emailsOf(c).length;
  n += (c.customFields ?? []).filter((x) => hasValue(x?.value)).length;
  if (clean(c.externalId)) n++;
  return n;
}

function createdMs(c: QuoContact): number {
  const t = Date.parse(c.createdAt ?? "");
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
}

function customValueKey(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : JSON.stringify(v);
}

/** Everything a copy carries that the kept contact does not: phones, emails, company, role and custom
 *  field values. Deleting the copies would lose these, so a non-empty list means "merge by hand". Names
 *  are not compared (an exact group shares one name; a review group is confirmed by a person). */
export function lostOnDelete(kept: QuoContact, others: QuoContact[]): string[] {
  const lost: string[] = [];
  const add = (s: string) => {
    if (!lost.includes(s)) lost.push(s);
  };
  const havePhones = new Set(phonesOf(kept));
  const haveEmails = new Set(emailsOf(kept));
  const kf = kept.defaultFields ?? {};
  const haveCustom = new Map<string, string>();
  for (const f of kept.customFields ?? []) {
    const ident = f?.key || f?.id;
    if (ident && hasValue(f.value)) haveCustom.set(ident, customValueKey(f.value));
  }
  for (const c of others) {
    const f = c.defaultFields ?? {};
    for (const p of phonesOf(c)) if (!havePhones.has(p)) add(`phone ${p}`);
    for (const e of emailsOf(c)) if (!haveEmails.has(e)) add(`email ${e}`);
    if (clean(f.company) && clean(f.company).toLowerCase() !== clean(kf.company).toLowerCase()) add(`company ${clean(f.company)}`);
    if (clean(f.role) && clean(f.role).toLowerCase() !== clean(kf.role).toLowerCase()) add(`role ${clean(f.role)}`);
    for (const x of c.customFields ?? []) {
      const ident = x?.key || x?.id;
      if (!ident || !hasValue(x.value)) continue;
      if (haveCustom.get(ident) !== customValueKey(x.value)) add(`${x.name || x.key || "custom field"}`);
    }
  }
  return lost;
}

/** The contact to keep. First choice: a member that already holds everything the others carry (so the
 *  merge only deletes). Then most complete, then the oldest (usually saved by hand), then id. */
export function pickSurvivor(contacts: QuoContact[]): QuoContact {
  const ranked = [...contacts].sort(
    (a, b) => completeness(b) - completeness(a) || createdMs(a) - createdMs(b) || a.id.localeCompare(b.id),
  );
  const covering = ranked.find((c) => lostOnDelete(c, contacts.filter((o) => o.id !== c.id)).length === 0);
  return covering ?? ranked[0];
}

/** Zoe's own addresses. Old Zaps stamped these onto customer contacts, so they say nothing about who the
 *  customer is and must never link two contacts. */
const INTERNAL_EMAIL = /@zoeeventsdmv\.com$|^form-submission@squarespace\.info$/;
/** A phone or email carried by this many different names is a shared line (office, venue, planner),
 *  not a person, and never links contacts. */
export const HUB_NAME_THRESHOLD = 3;

/** Keys ("p:<10 digits>" / "e:<email>") that must not link contacts. */
export function hubKeys(contacts: QuoContact[]): Set<string> {
  const names = new Map<string, Set<string>>();
  const hubs = new Set<string>();
  for (const c of contacts) {
    const n = nameKey(c);
    const keys = [...phonesOf(c).map((p) => `p:${p}`), ...emailsOf(c).map((e) => `e:${e}`)];
    for (const k of keys) {
      if (k.startsWith("e:") && INTERNAL_EMAIL.test(k.slice(2))) hubs.add(k);
      if (!n) continue;
      const s = names.get(k) ?? new Set<string>();
      s.add(n);
      names.set(k, s);
    }
  }
  for (const [k, s] of names) if (s.size >= HUB_NAME_THRESHOLD) hubs.add(k);
  return hubs;
}

export function findDuplicateGroups(contacts: QuoContact[]): DuplicateGroup[] {
  const hubs = hubKeys(contacts);
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  for (const c of contacts) parent.set(c.id, c.id);

  const firstWithKey = new Map<string, string>();
  for (const c of contacts) {
    const keys = [...phonesOf(c).map((p) => `p:${p}`), ...emailsOf(c).map((e) => `e:${e}`)];
    for (const k of keys) {
      if (hubs.has(k)) continue; // shared office/venue line: says nothing about who this is
      const seen = firstWithKey.get(k);
      if (seen) union(seen, c.id);
      else firstWithKey.set(k, c.id);
    }
  }

  const members = new Map<string, QuoContact[]>();
  for (const c of contacts) {
    const r = find(c.id);
    const list = members.get(r);
    if (list) list.push(c);
    else members.set(r, [c]);
  }

  const groups: DuplicateGroup[] = [];
  for (const list of members.values()) {
    if (list.length < 2) continue;
    const phoneCount = new Map<string, number>();
    const emailCount = new Map<string, number>();
    for (const c of list) {
      for (const p of phonesOf(c)) if (!hubs.has(`p:${p}`)) phoneCount.set(p, (phoneCount.get(p) ?? 0) + 1);
      for (const e of emailsOf(c)) if (!hubs.has(`e:${e}`)) emailCount.set(e, (emailCount.get(e) ?? 0) + 1);
    }
    const sharedPhones = [...phoneCount].filter(([, n]) => n > 1).map(([k]) => k).sort();
    const sharedEmails = [...emailCount].filter(([, n]) => n > 1).map(([k]) => k).sort();
    const nameKeys = new Set(list.map(nameKey).filter(Boolean));
    const names = [...new Set(list.map(displayName).filter(Boolean))].sort();
    const confidence: Confidence = nameKeys.size <= 1 ? "exact" : "review";
    const via = [
      sharedPhones.length ? `the same phone number${sharedPhones.length > 1 ? "s" : ""}` : "",
      sharedEmails.length ? `the same email${sharedEmails.length > 1 ? "s" : ""}` : "",
    ].filter(Boolean).join(" and ");
    const reason =
      confidence === "exact"
        ? `${list.length} contacts share ${via || "contact details"} and the same name (or no name).`
        : `${list.length} contacts share ${via || "contact details"} but carry different names. Check they are one person before merging.`;
    const ids = list.map((c) => c.id).sort();
    const survivor = pickSurvivor(list);
    const keptLacks = lostOnDelete(survivor, list.filter((c) => c.id !== survivor.id));
    groups.push({
      key: ids.join(","),
      contactIds: ids,
      confidence,
      reason,
      sharedPhones,
      sharedEmails,
      names,
      survivorId: survivor.id,
      deleteOnly: keptLacks.length === 0,
      keptLacks,
    });
  }
  // Exact first, then biggest groups first, then stable by key.
  return groups.sort(
    (a, b) =>
      (a.confidence === b.confidence ? 0 : a.confidence === "exact" ? -1 : 1) ||
      b.contactIds.length - a.contactIds.length ||
      a.key.localeCompare(b.key),
  );
}

/** True when `ids` (all present in `contacts`) form exactly ONE duplicate group on their own. The merge
 *  endpoint uses this so it can never be pointed at unrelated contacts. */
export function formsOneGroup(contacts: QuoContact[], ids: string[]): DuplicateGroup | null {
  const want = new Set(ids);
  const subset = contacts.filter((c) => want.has(c.id));
  if (subset.length !== want.size || subset.length < 2) return null;
  const groups = findDuplicateGroups(subset);
  return groups.length === 1 && groups[0].contactIds.length === subset.length ? groups[0] : null;
}

export interface DedupeStats {
  totalContacts: number;
  groups: number;
  exactGroups: number;
  reviewGroups: number;
  /** Contacts a full merge would remove (every member but the survivor, across all groups). */
  duplicateContacts: number;
  exactDuplicateContacts: number;
  /** Exact groups the app can merge safely (kept contact already holds everything) and their copies. */
  readyGroups: number;
  readyCopies: number;
  /** Groups that need details copied onto the kept contact first: merged by hand in Quo. */
  handMergeGroups: number;
  noPhoneOrEmail: number;
}

export function dedupeStats(contacts: QuoContact[], groups: DuplicateGroup[]): DedupeStats {
  const exact = groups.filter((g) => g.confidence === "exact");
  const ready = exact.filter((g) => g.deleteOnly);
  return {
    totalContacts: contacts.length,
    groups: groups.length,
    exactGroups: exact.length,
    reviewGroups: groups.length - exact.length,
    duplicateContacts: groups.reduce((n, g) => n + g.contactIds.length - 1, 0),
    exactDuplicateContacts: exact.reduce((n, g) => n + g.contactIds.length - 1, 0),
    readyGroups: ready.length,
    readyCopies: ready.reduce((n, g) => n + g.contactIds.length - 1, 0),
    handMergeGroups: groups.filter((g) => !g.deleteOnly).length,
    noPhoneOrEmail: contacts.filter((c) => phonesOf(c).length === 0 && emailsOf(c).length === 0).length,
  };
}
