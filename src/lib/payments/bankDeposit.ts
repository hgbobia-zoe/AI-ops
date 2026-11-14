// Bank side of the offline payment confirmation (owner idea, 2026-11-11): a Zapier zap watches the
// "Check Deposit" bank account and POSTs each deposit to /api/payments/bank-deposit. We match it to a
// Goodshuffle project so the confirmation card can say the money really landed:
//   1. a Goodshuffle project number (9 digits) in the memo/description that is a known project, else
//   2. an amount equal to ONE signed, active project's 50% deposit, remaining balance, or full total.
// Two or more candidates is "ambiguous" and links nothing (a wrong link is worse than none).
//
// PURE (no DB). The Zap sends Mercury's transaction fields; we read them leniently so another bank or a
// hand-built Zap body works too.

export interface NormalizedDeposit {
  depositId: string | null;
  amount: number | null; // dollars, positive for money in
  postedAt: string | null; // ISO
  description: string; // memo + counterparty + bank description, joined (for matching and display)
  account: string | null;
  status: string | null;
  /** Mercury transaction kind ("checkDeposit", "externalTransfer", ...), when the Zap sends it. */
  kind: string | null;
  accountId: string | null;
}

/** Mercury Checking ••4011 "Revenue - Check Deposit", where the team deposits customer checks. */
export const CHECK_DEPOSIT_ACCOUNT_ID = "37b3d452-c621-11f0-bc68-cb3b7834b0b2";

/** Is this a physical check? Mercury's kind says so; with no kind, the check deposit account does. ACH,
 *  wires and card payouts never count (Goodshuffle confirms ACH itself). PURE. */
export function isCheckDeposit(d: Pick<NormalizedDeposit, "kind" | "accountId" | "account">): boolean {
  if (d.kind) return d.kind === "checkDeposit";
  return d.accountId === CHECK_DEPOSIT_ACCOUNT_ID || /check deposit/i.test(d.account ?? "");
}

function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[$,\s]/g, ""));
    return v.trim() && Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Read a deposit from a Zap body. Accepts Mercury names (transactionId, amount, postedAt/createdAt,
 *  counterpartyName, bankDescription, note, externalMemo, accountName) and plain ones (id, date, memo). */
export function normalizeDeposit(raw: unknown): NormalizedDeposit {
  const b = (raw ?? {}) as Record<string, unknown>;
  const desc = [b.note, b.externalMemo, b.memo, b.description, b.counterpartyName, b.bankDescription]
    .map(str)
    .filter((s): s is string => !!s);
  const when = str(b.postedAt) ?? str(b.date) ?? str(b.createdAt);
  const t = when ? Date.parse(when) : NaN;
  return {
    depositId: str(b.transactionId) ?? str(b.id),
    amount: num(b.amount),
    postedAt: Number.isFinite(t) ? new Date(t).toISOString() : null,
    description: Array.from(new Set(desc)).join(" | "),
    account: str(b.accountName) ?? str(b.account),
    status: str(b.status)?.toLowerCase() ?? null,
    kind: str(b.kind),
    accountId: str(b.accountId),
  };
}

/** Goodshuffle project numbers mentioned in free text (9 digit ids, e.g. "Project #231812125"). PURE. */
export function projectNumbersIn(text: string): string[] {
  const out: string[] = [];
  for (const m of (text ?? "").matchAll(/(?<!\d)(\d{9})(?!\d)/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

export interface DepositCandidate {
  bookingId: string;
  signed: boolean;
  archived: boolean;
  eventDate: string | null;
  grandTotal: number | null;
  amountDue: number | null; // Goodshuffle amount_due
}

export type MatchKind = "project_number" | "deposit_50" | "amount_due" | "full_total";

export interface DepositMatch {
  bookingId: string | null;
  kind: MatchKind | "ambiguous" | "none";
  note: string;
}

export const MATCH_LABEL: Record<MatchKind, string> = {
  project_number: "project number in the memo",
  deposit_50: "the 50% deposit amount",
  amount_due: "the amount due on the project",
  full_total: "the full project total",
};

const CENT = 0.005;
const near = (a: number | null, b: number): boolean => a != null && a > 0 && Math.abs(a - b) < CENT;

/** Match a deposit to one project. `knownIds` = project numbers that exist (any status). `candidates` =
 *  signed, not archived projects with an event no older than the look-back. PURE. */
export function matchDeposit(d: Pick<NormalizedDeposit, "amount" | "description">, knownIds: ReadonlySet<string>, candidates: DepositCandidate[]): DepositMatch {
  const byNumber = projectNumbersIn(d.description).filter((id) => knownIds.has(id));
  if (byNumber.length === 1) return { bookingId: byNumber[0], kind: "project_number", note: `Project ${byNumber[0]} named in the memo.` };
  if (byNumber.length > 1) return { bookingId: null, kind: "ambiguous", note: `Memo names ${byNumber.length} projects (${byNumber.join(", ")}).` };

  const amt = d.amount;
  if (amt == null || amt <= 0) return { bookingId: null, kind: "none", note: "No positive amount." };
  const hits: { id: string; kind: MatchKind }[] = [];
  for (const c of candidates) {
    if (!c.signed || c.archived) continue;
    if (c.grandTotal != null && near(c.grandTotal / 2, amt)) hits.push({ id: c.bookingId, kind: "deposit_50" });
    else if (near(c.amountDue, amt)) hits.push({ id: c.bookingId, kind: "amount_due" });
    else if (near(c.grandTotal, amt)) hits.push({ id: c.bookingId, kind: "full_total" });
  }
  if (hits.length === 1) return { bookingId: hits[0].id, kind: hits[0].kind, note: `Amount equals ${MATCH_LABEL[hits[0].kind]} of project ${hits[0].id}.` };
  if (hits.length > 1) return { bookingId: null, kind: "ambiguous", note: `Amount fits ${hits.length} projects (${hits.map((h) => h.id).slice(0, 5).join(", ")}). Put the project number in the deposit memo to link it.` };
  return { bookingId: null, kind: "none", note: "No signed project has this deposit, balance or total." };
}
