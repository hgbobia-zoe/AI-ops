// Prospecting — cold email sequencer bridge (Instantly or Smartlead). Tier B email is sent from a DEDICATED
// cold email tool on separate warmed domains (never from the primary domain). We never send from here: the
// tool owns sending, warmup, inbox rotation, throttling, the email steps and unsubscribe handling. Two paths:
//   • Push: one LEAD per enrollment (not one row per step; the tool's campaign owns the steps), with the
//     personalized intro passed as custom variables ({{intro_subject}}, {{intro_body}}). Only after a
//     person approves the list in the app (see service.ts pushApproved).
//   • CSV export of due email steps for manual sending or any other tool.
//
// Provider: chosen on /radar/outreach (kv prospecting.provider), else SEQUENCER_PROVIDER, else Instantly
// (the owner's pick, 2026-11-08). Credentials per provider live in the `secrets` table
// (instantly.apiKey / instantly.campaignId, smartlead.apiKey / smartlead.campaignId), falling back to
// SEQUENCER_API_KEY / SEQUENCER_CAMPAIGN_ID for the active provider only. Keys never leave the server and
// never appear in an error. Instantly calls live in ./instantly.ts. Smartlead API: POST
// https://server.smartlead.ai/api/v1/campaigns/{id}/leads?api_key= (max 400 leads a call; we send 100).
// Leads on Smartlead's block, unsubscribe or bounce lists, or already in another campaign, are skipped by
// Smartlead (all ignore_* settings are false).

import type { StoredTask } from "./store";
import { getSecret } from "@/lib/secrets";
import { getJson, setJson } from "@/lib/kv";
import { pushLeadsToInstantly, probeInstantly } from "./instantly";

export const SMARTLEAD_BASE = "https://server.smartlead.ai/api/v1";
export const SMARTLEAD_KEY_SECRET = "smartlead.apiKey";
export const SMARTLEAD_CAMPAIGN_SECRET = "smartlead.campaignId";
export const INSTANTLY_KEY_SECRET = "instantly.apiKey";
export const INSTANTLY_CAMPAIGN_SECRET = "instantly.campaignId";
const PROVIDER_KEY = "prospecting.provider";
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
export type SequencerProvider = "instantly" | "smartlead";
export const SEQUENCER_PROVIDERS: SequencerProvider[] = ["instantly", "smartlead"];
export const PROVIDER_LABEL: Record<SequencerProvider, string> = { instantly: "Instantly", smartlead: "Smartlead" };
const SECRETS: Record<SequencerProvider, { key: string; campaign: string }> = {
  instantly: { key: INSTANTLY_KEY_SECRET, campaign: INSTANTLY_CAMPAIGN_SECRET },
  smartlead: { key: SMARTLEAD_KEY_SECRET, campaign: SMARTLEAD_CAMPAIGN_SECRET },
};
export const isSequencerProvider = (v: unknown): v is SequencerProvider => v === "instantly" || v === "smartlead";

function envProvider(): string {
  return (process.env.SEQUENCER_PROVIDER ?? "").trim().toLowerCase();
}
function chosenProvider(): SequencerProvider | null {
  const v = getJson<string | null>(PROVIDER_KEY, null);
  return isSequencerProvider(v) ? v : null;
}
/** The provider pushes go to: the in-app choice, else a supported SEQUENCER_PROVIDER, else Instantly. */
export function activeProvider(): SequencerProvider {
  const env = envProvider();
  return chosenProvider() ?? (isSequencerProvider(env) ? env : "instantly");
}
export function setActiveProvider(p: SequencerProvider): void {
  setJson(PROVIDER_KEY, p);
}
/** SEQUENCER_PROVIDER names a tool we don't support and no in-app choice overrides it. Returns the
 *  unsupported name, or null. */
export function unsupportedProvider(): string | null {
  if (chosenProvider()) return null;
  const p = envProvider();
  return p && !isSequencerProvider(p) ? p : null;
}
/** The env fallbacks belong to the active provider only, so a key for one tool is never sent to the other. */
export function providerApiKey(p: SequencerProvider = activeProvider()): string | null {
  const env = p === activeProvider() ? process.env.SEQUENCER_API_KEY : "";
  return (getSecret(SECRETS[p].key) || env || "").trim() || null;
}
export function providerCampaignId(p: SequencerProvider = activeProvider()): string | null {
  const env = p === activeProvider() ? process.env.SEQUENCER_CAMPAIGN_ID : "";
  return (getSecret(SECRETS[p].campaign) || env || "").trim() || null;
}
export function providerSecretNames(p: SequencerProvider): { key: string; campaign: string } {
  return SECRETS[p];
}
export function smartleadKey(): string | null {
  return providerApiKey("smartlead");
}
export function smartleadCampaignId(): string | null {
  return providerCampaignId("smartlead");
}
/** Campaign id shape per tool, both copied from the campaign URL: Smartlead a number, Instantly a UUID. */
export function validCampaignId(p: SequencerProvider, id: string): boolean {
  return p === "smartlead" ? /^\d+$/.test(id) : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
/** Ready to push: the active provider has a key + campaign, and no unsupported provider is selected. */
export function sequencerConfigured(): boolean {
  return Boolean(providerApiKey() && providerCampaignId() && !unsupportedProvider());
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
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface SmartleadLead {
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  website?: string;
  location?: string;
  custom_fields?: Record<string, string>;
}

/** One lead, tool neutral. `vars` become Smartlead custom_fields / Instantly custom_variables. */
export interface OutreachLead {
  email: string;
  firstName?: string;
  company?: string;
  website?: string;
  location?: string;
  vars: Record<string, string>;
}

export interface PushResult {
  ok: boolean;
  provider: SequencerProvider;
  added: number;
  skipped: number;
  /** Emails the tool skipped (block / unsubscribe / bounce / duplicate / invalid). Lowercased. */
  skippedEmails: string[];
  /** Emails in a batch that failed outright (HTTP / network). Not marked as pushed; retry later. */
  failedEmails: string[];
  errors: string[];
}

export const scrub = (msg: string, key: string) => (key ? msg.split(key).join("***") : msg);

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

// ── Provider neutral ────────────────────────────────────────────────────────────────────────────────
export function toSmartleadLead(l: OutreachLead): SmartleadLead {
  return { email: l.email, first_name: l.firstName, company_name: l.company, website: l.website, location: l.location, custom_fields: l.vars };
}

/** Push to the given provider. Never throws; never returns the key. */
export async function pushLeads(
  provider: SequencerProvider,
  leads: OutreachLead[],
  opts: { key: string; campaignId: string; fetchImpl?: FetchLike },
): Promise<PushResult> {
  return provider === "instantly" ? pushLeadsToInstantly(leads, opts) : pushLeadsToSmartlead(leads.map(toSmartleadLead), opts);
}

/** Check a provider's key + campaign by reading the campaign. Never throws, never returns the key. */
export async function probeProvider(p: SequencerProvider = activeProvider(), fetchImpl?: FetchLike): Promise<{ ok: boolean; campaignName?: string; status?: string; error?: string }> {
  if (p === "smartlead") return probeSmartlead(fetchImpl);
  const key = providerApiKey("instantly");
  const campaignId = providerCampaignId("instantly");
  if (!key || !campaignId) return { ok: false, error: "API key and campaign id are both required" };
  return probeInstantly({ key, campaignId, fetchImpl });
}

/** Turn an email task + its context into a CSV row (skips tasks with no email). */
export function taskToRow(task: StoredTask, ctx: { email: string | null; firstName: string; company: string; opportunity: string; jurisdiction: string; tier: string }): SequencerRow | null {
  if (task.channel !== "email" || !ctx.email) return null;
  return { email: ctx.email, firstName: ctx.firstName, company: ctx.company, subject: task.subject ?? "", body: task.body ?? "", opportunity: ctx.opportunity, jurisdiction: ctx.jurisdiction, tier: ctx.tier, step: task.stepIndex };
}
