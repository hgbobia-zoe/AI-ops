// Prospecting — cold email sequencer bridge (Smartlead). Tier B email is sent from a DEDICATED cold email
// tool on a separate warmed domain (never from the primary domain). We never send from here: Smartlead
// owns sending, warmup, throttling, the email steps and unsubscribe handling. Two paths:
//   • Smartlead push: one LEAD per enrollment (not one row per step; the Smartlead campaign owns the
//     steps), with the personalized intro passed as custom fields ({{intro_subject}}, {{intro_body}}).
//     Only after a person approves the list in the app (see service.ts pushApproved).
//   • CSV export of due email steps for manual sending or any other tool.
//
// Credentials: the `secrets` table (smartlead.apiKey, smartlead.campaignId; set from /radar/outreach),
// falling back to SEQUENCER_API_KEY / SEQUENCER_CAMPAIGN_ID. The key never leaves the server and never
// appears in an error. Smartlead API: POST https://server.smartlead.ai/api/v1/campaigns/{id}/leads?api_key=
// (max 400 leads a call; we send 100). Leads on Smartlead's block, unsubscribe or bounce lists, or already
// in another campaign, are skipped by Smartlead (all ignore_* settings are false).

import type { StoredTask } from "./store";
import { getSecret } from "@/lib/secrets";
import { getJson, setJson } from "@/lib/kv";

export const SMARTLEAD_BASE = "https://server.smartlead.ai/api/v1";
export const SMARTLEAD_KEY_SECRET = "smartlead.apiKey";
export const SMARTLEAD_CAMPAIGN_SECRET = "smartlead.campaignId";
const MAILING_KEY = "prospecting.mailingAddress";
// Zoe's public business address (Google Business Profile). Editable on /radar/outreach.
export const DEFAULT_MAILING_ADDRESS = "12712 Rock Creek Mill Rd, Suite 4A, Rockville, MD 20852";
const BATCH = 100;

export interface SequencerRow {
  email: string;
  firstName: string;
  company: string;
  subject: string;
  body: string;
  opportunity: string;
  jurisdiction: string;
  tier: string;
  step: number;
}

function csvEscape(s: string): string {
  const needs = /[",\n]/.test(s);
  const v = s.replace(/"/g, '""');
  return needs ? `"${v}"` : v;
}

/** Build a CSV string from sequencer rows. Header matches the common cold email import format. */
export function toCsv(rows: SequencerRow[]): string {
  const header = ["email", "first_name", "company", "subject", "body", "opportunity", "jurisdiction", "tier", "step"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([r.email, r.firstName, r.company, r.subject, r.body, r.opportunity, r.jurisdiction, r.tier, String(r.step)].map((x) => csvEscape(x ?? "")).join(","));
  }
  return lines.join("\n");
}

// ── Config ──────────────────────────────────────────────────────────────────────────────────────────
export function smartleadKey(): string | null {
  return (getSecret(SMARTLEAD_KEY_SECRET) || process.env.SEQUENCER_API_KEY || "").trim() || null;
}
export function smartleadCampaignId(): string | null {
  return (getSecret(SMARTLEAD_CAMPAIGN_SECRET) || process.env.SEQUENCER_CAMPAIGN_ID || "").trim() || null;
}
/** A provider other than Smartlead configured by env is not supported (the old Instantly path used a
 *  retired API). Returns the unsupported name, or null. */
export function unsupportedProvider(): string | null {
  const p = (process.env.SEQUENCER_PROVIDER ?? "").trim().toLowerCase();
  return p && p !== "smartlead" ? p : null;
}
/** Ready to push: key + campaign set, and no unsupported provider selected. */
export function sequencerConfigured(): boolean {
  return Boolean(smartleadKey() && smartleadCampaignId() && !unsupportedProvider());
}
export function mailingAddress(): string {
  return (getJson<string | null>(MAILING_KEY, null) || process.env.ZOE_MAILING_ADDRESS || DEFAULT_MAILING_ADDRESS).trim();
}
export function setMailingAddress(v: string): void {
  setJson(MAILING_KEY, v.trim());
}

/** CAN-SPAM footer: who we are, a real postal address, and how to opt out. House voice, no dashes. */
export function complianceFooter(): string {
  return `\n\nZoe Event Rentals\n${mailingAddress()}\nNot the right contact? Reply "remove" and we will not reach out again.`;
}

// ── Smartlead calls ─────────────────────────────────────────────────────────────────────────────────
type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface SmartleadLead {
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  website?: string;
  location?: string;
  custom_fields?: Record<string, string>;
}

export interface PushResult {
  ok: boolean;
  provider: "smartlead";
  added: number;
  skipped: number;
  /** Emails Smartlead reported as skipped (block / unsubscribe / bounce / duplicate). Lowercased. */
  skippedEmails: string[];
  /** Emails in a batch that failed outright (HTTP / network). Not marked as pushed; retry later. */
  failedEmails: string[];
  errors: string[];
}

const scrub = (msg: string, key: string) => (key ? msg.split(key).join("***") : msg);

/** PURE apart from the injected fetch. Push leads in batches; never throws. */
export async function pushLeadsToSmartlead(
  leads: SmartleadLead[],
  opts: { key: string; campaignId: string; fetchImpl?: FetchLike },
): Promise<PushResult> {
  const out: PushResult = { ok: true, provider: "smartlead", added: 0, skipped: 0, skippedEmails: [], failedEmails: [], errors: [] };
  const f = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const url = `${SMARTLEAD_BASE}/campaigns/${encodeURIComponent(opts.campaignId)}/leads?api_key=${encodeURIComponent(opts.key)}`;
  for (let i = 0; i < leads.length; i += BATCH) {
    const batch = leads.slice(i, i + BATCH);
    try {
      const res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lead_list: batch,
          settings: { ignore_global_block_list: false, ignore_unsubscribe_list: false, ignore_duplicate_leads_in_other_campaign: false, ignore_community_bounce_list: false },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`Smartlead HTTP ${res.status}${res.status === 401 ? " (check the API key)" : res.status === 404 ? " (check the campaign id)" : ""}`);
      const data = (await res.json().catch(() => ({}))) as {
        added_count?: number;
        upload_count?: number;
        skipped_count?: number;
        skipped_leads?: ({ email?: string } | string)[];
      };
      const skippedEmails = (data.skipped_leads ?? []).map((s) => (typeof s === "string" ? s : s?.email ?? "")).filter(Boolean).map((e) => e.toLowerCase());
      const skipped = typeof data.skipped_count === "number" ? data.skipped_count : skippedEmails.length;
      const added = typeof data.added_count === "number" ? data.added_count : typeof data.upload_count === "number" ? data.upload_count : batch.length - skipped;
      out.added += added;
      out.skipped += skipped;
      out.skippedEmails.push(...skippedEmails);
    } catch (e) {
      out.ok = false;
      out.errors.push(scrub((e as Error).message, opts.key));
      out.failedEmails.push(...batch.map((l) => l.email.toLowerCase()));
    }
  }
  return out;
}

/** Check the key + campaign: reads the campaign. Never throws, never returns the key. */
export async function probeSmartlead(fetchImpl?: FetchLike): Promise<{ ok: boolean; campaignName?: string; status?: string; error?: string }> {
  const key = smartleadKey();
  const campaign = smartleadCampaignId();
  if (!key || !campaign) return { ok: false, error: "API key and campaign id are both required" };
  try {
    const f = fetchImpl ?? (fetch as unknown as FetchLike);
    const res = await f(`${SMARTLEAD_BASE}/campaigns/${encodeURIComponent(campaign)}?api_key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { ok: false, error: `Smartlead HTTP ${res.status}${res.status === 401 ? " (check the API key)" : res.status === 404 ? " (check the campaign id)" : ""}` };
    const data = (await res.json().catch(() => ({}))) as { name?: string; status?: string };
    return { ok: true, campaignName: data.name, status: data.status };
  } catch (e) {
    return { ok: false, error: scrub((e as Error).message, key) };
  }
}

/** Turn an email task + its context into a CSV row (skips tasks with no email). */
export function taskToRow(task: StoredTask, ctx: { email: string | null; firstName: string; company: string; opportunity: string; jurisdiction: string; tier: string }): SequencerRow | null {
  if (task.channel !== "email" || !ctx.email) return null;
  return { email: ctx.email, firstName: ctx.firstName, company: ctx.company, subject: task.subject ?? "", body: task.body ?? "", opportunity: ctx.opportunity, jurisdiction: ctx.jurisdiction, tier: ctx.tier, step: task.stepIndex };
}
