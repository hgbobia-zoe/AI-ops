// Prospecting: EMAIL CHECKS before anything goes into a cold email campaign.
// Owner (2026-11-09): "verify before we put anything in the campaign to avoid bounce". Bounces burn the
// sending inboxes, so no address is pushed (purchased list or Radar outreach) unless it passed here.
//   1. Free domain check: no mail server for the domain (no MX record) = it would bounce. No credits.
//   2. Instantly's verifier (POST /api/v2/email-verification) for the rest, 1 credit per address. It
//      answers verified / invalid / pending, and says separately whether the domain is catch-all.
//   3. One saved result per address (email_verifications), reused by every list and by Radar, so nobody is
//      checked or paid for twice. Results older than VERIFY_TTL_DAYS are checked again.
// Catch-all domains accept any address, so the verifier can't confirm the person exists. They are held
// back unless a list opts in.

import { Resolver } from "node:dns/promises";
import { getDb } from "@/lib/db";
import { INSTANTLY_BASE } from "./instantly";
import { scrub, type FetchLike } from "./sequencer";

export type CheckResult = "valid" | "catch_all" | "invalid" | "no_mail_server" | "pending";
export type CheckState = CheckResult | "unchecked";
export const VERIFY_TTL_DAYS = 90;
/** A pending answer older than this is asked again from scratch. */
const PENDING_RETRY_MS = 24 * 3600_000;
export const VERIFY_BATCH = 100;
const CONCURRENCY = 4;

export interface EmailCheck {
  email: string;
  result: CheckResult;
  detail: string | null;
  provider: string | null;
  creditsUsed: number | null;
  checkedAt: string;
}

export const CHECK_LABEL: Record<CheckState, string> = {
  valid: "email verified",
  catch_all: "catch-all domain",
  invalid: "email would bounce",
  no_mail_server: "domain has no mail server",
  pending: "check still running",
  unchecked: "not checked yet",
};

// ── Stored results ────────────────────────────────────────────────────────────────────────────────
/* eslint-disable @typescript-eslint/no-explicit-any */
const toCheck = (r: any): EmailCheck => ({
  email: r.email, result: r.result, detail: r.detail ?? null, provider: r.provider ?? null, creditsUsed: r.credits_used ?? null, checkedAt: r.checked_at,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

/** True when a saved result can still be trusted. */
export function isFresh(c: EmailCheck, now: Date = new Date()): boolean {
  const age = now.getTime() - Date.parse(c.checkedAt);
  if (c.result === "pending") return age < PENDING_RETRY_MS;
  return age < VERIFY_TTL_DAYS * 86400_000;
}

/** Every saved result, by email (stale ones included; callers use isFresh). */
export function allChecks(): Map<string, EmailCheck> {
  const m = new Map<string, EmailCheck>();
  for (const r of getDb().prepare("SELECT * FROM email_verifications").all()) { const c = toCheck(r); m.set(c.email, c); }
  return m;
}

export function getCheck(email: string): EmailCheck | null {
  const r = getDb().prepare("SELECT * FROM email_verifications WHERE email=?").get(email.trim().toLowerCase());
  return r ? toCheck(r) : null;
}

function saveCheck(c: EmailCheck): void {
  getDb().prepare(
    `INSERT INTO email_verifications (email, result, detail, provider, credits_used, checked_at) VALUES (?,?,?,?,?,?)
     ON CONFLICT(email) DO UPDATE SET result=excluded.result, detail=excluded.detail, provider=excluded.provider, credits_used=excluded.credits_used, checked_at=excluded.checked_at`,
  ).run(c.email, c.result, c.detail, c.provider, c.creditsUsed, c.checkedAt);
}

/** PURE. Where an address stands, from its saved result. Stale results count as unchecked. */
export function checkState(c: EmailCheck | null | undefined, now: Date = new Date()): CheckState {
  if (!c || !isFresh(c, now)) return "unchecked";
  return c.result;
}

/** PURE. Can this address go into a campaign, and if not, why. */
export function checkVerdict(state: CheckState, includeCatchAll = false): { sendable: boolean; reason: string | null } {
  switch (state) {
    case "valid": return { sendable: true, reason: null };
    case "catch_all": return includeCatchAll ? { sendable: true, reason: null } : { sendable: false, reason: "catch-all domain: the address can't be confirmed" };
    case "invalid": return { sendable: false, reason: "email failed the check (it would bounce)" };
    case "no_mail_server": return { sendable: false, reason: "the email's domain has no mail server" };
    case "pending": return { sendable: false, reason: "email check still running" };
    default: return { sendable: false, reason: "email not checked yet" };
  }
}

/** Still needs a check (nothing saved, stale, or a pending answer to collect). */
export const needsCheck = (state: CheckState) => state === "unchecked" || state === "pending";

// ── Domain check (free) ───────────────────────────────────────────────────────────────────────────
export type MxLookup = (domain: string) => Promise<{ exchange: string; priority: number }[]>;

const resolver = new Resolver({ timeout: 4000, tries: 2 });
const defaultMx: MxLookup = (d) => resolver.resolveMx(d);

/** true = the domain takes mail, false = it can't (no MX / no such domain), null = DNS didn't answer. */
export async function domainTakesMail(domain: string, lookup: MxLookup = defaultMx): Promise<boolean | null> {
  try {
    const mx = await lookup(domain);
    // A "null MX" (RFC 7505: a single "." record) means the domain refuses mail.
    return mx.some((r) => r.exchange && r.exchange !== ".");
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN") return false;
    return null;
  }
}

// ── Instantly verifier ────────────────────────────────────────────────────────────────────────────
interface InstantlyVerification { verification_status?: string; catch_all?: boolean | string; credits?: number | null; credits_used?: number | null }

/** PURE. Map Instantly's answer to a result. */
export function mapInstantly(v: InstantlyVerification): CheckResult {
  const s = String(v.verification_status ?? "").toLowerCase();
  if (s === "invalid") return "invalid";
  if (s === "verified") {
    if (v.catch_all === true || v.catch_all === "true") return "catch_all";
    if (v.catch_all === false || v.catch_all === "false" || v.catch_all == null) return "valid";
    return "pending"; // catch-all still being worked out
  }
  return "pending";
}

const STOP: Record<number, string> = {
  401: "Instantly rejected the API key",
  403: "the Instantly API key needs the email verification scope",
  402: "Instantly says there is no paid plan or no verification credits left",
  429: "Instantly rate limit reached; continue in a minute",
};

export interface VerifyRun {
  /** Addresses that got an answer this run (pending included). */
  checked: number;
  counts: Record<CheckResult, number>;
  /** Of the addresses asked about, how many still need a check after this run. */
  remaining: number;
  /** Why the run stopped early (key, credits, rate limit), else null. */
  stopped: string | null;
  errors: string[];
  creditsLeft: number | null;
  creditsUsed: number;
}

/** Check up to opts.max addresses that need it. Never throws. Without an Instantly key only the free domain
 *  check runs, and the rest stay unchecked. */
export async function verifyEmails(
  emails: string[],
  opts: { key: string | null; fetchImpl?: FetchLike; mxLookup?: MxLookup; now?: () => Date; max?: number } ,
): Promise<VerifyRun> {
  const clock = opts.now ?? (() => new Date());
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init) as ReturnType<FetchLike>);
  const run: VerifyRun = { checked: 0, counts: { valid: 0, catch_all: 0, invalid: 0, no_mail_server: 0, pending: 0 }, remaining: 0, stopped: null, errors: [], creditsLeft: null, creditsUsed: 0 };
  const unique = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const saved = new Map<string, EmailCheck>();
  for (const e of unique) { const c = getCheck(e); if (c) saved.set(e, c); }
  const todo = unique.filter((e) => needsCheck(checkState(saved.get(e), clock()))).slice(0, opts.max ?? VERIFY_BATCH);

  const domains = new Map<string, Promise<boolean | null>>();
  const record = (email: string, result: CheckResult, detail: string, provider: string, creditsUsed: number | null) => {
    saveCheck({ email, result, detail, provider, creditsUsed, checkedAt: clock().toISOString() });
    run.checked++;
    run.counts[result]++;
  };

  async function one(email: string): Promise<void> {
    const domain = email.split("@")[1] ?? "";
    if (!domains.has(domain)) domains.set(domain, domainTakesMail(domain, opts.mxLookup));
    const takes = await domains.get(domain)!;
    if (takes === false) { record(email, "no_mail_server", `no mail server for ${domain}`, "dns", null); return; }
    if (!opts.key || run.stopped) return;
    const prior = saved.get(email);
    const askAgain = prior?.result === "pending" && isFresh(prior, clock());
    const key = opts.key;
    try {
      const res = askAgain
        ? await doFetch(`${INSTANTLY_BASE}/email-verification/${encodeURIComponent(email)}`, { headers: { Authorization: `Bearer ${key}` } })
        : await doFetch(`${INSTANTLY_BASE}/email-verification`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
      if (!res.ok) {
        if (STOP[res.status]) { run.stopped ??= STOP[res.status]; return; }
        run.errors.push(`Instantly HTTP ${res.status} for ${email}`);
        return;
      }
      const v = (await res.json()) as InstantlyVerification;
      if (typeof v.credits === "number") run.creditsLeft = v.credits;
      const used = typeof v.credits_used === "number" ? v.credits_used : null;
      if (used) run.creditsUsed += used;
      const result = mapInstantly(v);
      record(email, result, `Instantly: ${v.verification_status ?? "?"}${v.catch_all === true || v.catch_all === "true" ? ", catch-all" : ""}`, "instantly", used);
    } catch (e) {
      run.errors.push(scrub(`Instantly check failed for ${email}: ${(e as Error).message}`, key));
    }
  }

  let next = 0;
  const worker = async () => { while (next < todo.length && !run.stopped) await one(todo[next++]); };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  if (!opts.key && todo.length) run.stopped = "add an Instantly API key to check emails (only the free domain check ran)";

  const now = clock();
  run.remaining = unique.filter((e) => needsCheck(checkState(getCheck(e), now))).length;
  run.errors = run.errors.slice(0, 5);
  return run;
}
