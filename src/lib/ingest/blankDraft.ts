// Blank Goodshuffle drafts: the ONE definition every lead/project count uses to keep them out.
//
// Why this exists: `GET /app/project/createNewProject` creates a blank draft on EVERY hit. On 2026-10-31
// Goodshuffle stopped redirecting that URL and the Auto-Pull extension's create drain looped, leaving 68
// blank "Unnamed Project" drafts (ids 231976120 to 231976221, ours only; GS ids are global across tenants).
// They were ARCHIVED, not deleted, and an archive-inclusive pull (searchProjects allProjects=true) still
// returns archived rows, so without this filter they inflate new-lead counts, the Sales OS pipeline, the
// stage snapshot and trends. A blank draft is NOT a lead: nobody named it, no client, no items, no money.
//
// Definition (ALL must hold, so a real lead is never dropped):
//   • unsigned
//   • name empty or "Unnamed Project..." (GS shows "Unnamed Project (<id>)" for a draft with no name)
//   • no client: name, email and phone all empty
//   • no money: grand total, contract total and amount paid all null or 0
//   • no captured line items (null = never captured, or an empty list)
// `archived` is deliberately NOT part of the definition: Goodshuffle also archives completed WON events, so
// archived alone must never hide a real booking. Archived blank drafts are excluded because they are blank.
//
// Pure (no DB import). The SQL twin below MUST stay in lockstep with isBlankDraft(); blankDraft.test.ts
// checks the two agree row for row against the real in-memory SQLite.

export interface BlankDraftInput {
  eventName?: string | null;
  signed?: boolean | null;
  clientName?: string | null;
  clientEmail?: string | null;
  clientPhone?: string | null;
  grandTotal?: number | null;
  contractTotal?: number | null;
  amountPaid?: number | null;
  lineItems?: string[] | null;
}

const blank = (s: string | null | undefined): boolean => !s || s.trim() === "";
const zero = (n: number | null | undefined): boolean => n == null || !Number.isFinite(n) || n === 0;

/** True for an empty name or Goodshuffle's placeholder "Unnamed Project" / "Unnamed Project (123)". */
export function isUnnamedProjectName(name: string | null | undefined): boolean {
  if (blank(name)) return true;
  return name!.trim().toLowerCase().startsWith("unnamed project");
}

/** True when a Goodshuffle project is a blank draft (see the definition at the top of this file). */
export function isBlankDraft(b: BlankDraftInput): boolean {
  return (
    !b.signed &&
    isUnnamedProjectName(b.eventName) &&
    blank(b.clientName) &&
    blank(b.clientEmail) &&
    blank(b.clientPhone) &&
    zero(b.grandTotal) &&
    zero(b.contractTotal) &&
    zero(b.amountPaid) &&
    (b.lineItems == null || b.lineItems.length === 0)
  );
}

/** Drop blank drafts from a list (for in-memory counts). */
export function withoutBlankDrafts<T extends BlankDraftInput>(rows: T[]): T[] {
  return rows.filter((r) => !isBlankDraft(r));
}

/** SQL twin of isBlankDraft() over the `bookings` table columns (unaliased, single-table queries). */
export const BLANK_DRAFT_SQL = `(
  COALESCE(signed,0) = 0
  AND (TRIM(COALESCE(event_name,'')) = '' OR LOWER(TRIM(event_name)) LIKE 'unnamed project%')
  AND TRIM(COALESCE(client_name,'')) = ''
  AND TRIM(COALESCE(client_email,'')) = ''
  AND TRIM(COALESCE(client_phone,'')) = ''
  AND COALESCE(grand_total,0) = 0
  AND COALESCE(contract_total,0) = 0
  AND COALESCE(amount_paid,0) = 0
  AND (line_items IS NULL OR TRIM(line_items) IN ('','[]'))
)`;

/** `AND`-ready filter that keeps everything EXCEPT blank drafts. */
export const NOT_BLANK_DRAFT_SQL = `NOT ${BLANK_DRAFT_SQL}`;

// ── Runaway-create guard ──────────────────────────────────────────────────────────────────────────────

export interface BlankDraftBurst {
  date: string; // YYYY-MM-DD (Goodshuffle date_created)
  count: number;
  ids: string[]; // sorted ascending (numeric when possible)
}

/** Default: more than 5 blank drafts created in one day is a create loop, not a person clicking New. */
export const BLANK_DRAFT_BURST_THRESHOLD = 5;

/**
 * Days (on or after `sinceYmd`) where MORE than `threshold` blank drafts were created. A person makes a
 * stray blank now and then; a loop makes one every couple of minutes. Rows without a date_created are
 * ignored (we can't place them in a day). Pure; the ingest route decides whether to alert (deduped).
 */
export function findBlankDraftBursts<T extends BlankDraftInput & { bookingId: string; dateCreated?: string | null }>(
  rows: T[],
  sinceYmd: string,
  threshold: number = BLANK_DRAFT_BURST_THRESHOLD,
): BlankDraftBurst[] {
  const byDay = new Map<string, string[]>();
  for (const r of rows) {
    const d = r.dateCreated;
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d) || d < sinceYmd) continue;
    if (!isBlankDraft(r)) continue;
    const list = byDay.get(d) ?? [];
    list.push(r.bookingId);
    byDay.set(d, list);
  }
  const out: BlankDraftBurst[] = [];
  for (const [date, ids] of byDay) {
    if (ids.length <= threshold) continue;
    const sorted = [...ids].sort((a, b) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a.localeCompare(b)));
    out.push({ date, count: ids.length, ids: sorted });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** The Slack text for a burst. House style: no dashes, no emoji, short. */
export function blankDraftBurstMessage(b: BlankDraftBurst): string {
  const range = b.ids.length > 1 ? `ids ${b.ids[0]} to ${b.ids[b.ids.length - 1]}` : `id ${b.ids[0]}`;
  return `Goodshuffle got ${b.count} blank Unnamed Project drafts created on ${b.date} (${range}). That looks like a create loop in an Auto Pull extension. Check the gs outbox and the office browsers, then archive the blanks in Goodshuffle. They are left out of lead counts.`;
}
