// Prospecting — Instantly (API v2) calls for the cold email bridge. See sequencer.ts for the overall flow:
// the app never sends email; Instantly sends from its warmed inboxes after a person approves the push.
//
// Auth: `Authorization: Bearer <key>`. Create the key in Instantly → Settings → Integrations → API keys with
// the leads (create) and campaigns (read) scopes. API v2 is on every paid plan per Instantly's pricing page.
//   • Add leads: POST https://api.instantly.ai/api/v2/leads/add  { campaign_id, leads[≤1000], skip_if_* }
//     → { leads_uploaded, skipped_count, in_blocklist, invalid_email_count, duplicated_leads, …,
//         created_leads: [{ index, id, email }] }. There is no list of skipped emails, so anything we sent
//     that is not in created_leads counts as skipped.
//   • Read a campaign: GET https://api.instantly.ai/api/v2/campaigns/{id}  → { id, name, status }.
// skip_if_in_workspace is ON: a person already anywhere in the Instantly workspace (another campaign, a
// past push) is never added twice. The workspace blocklist always applies.
//
// Type-only imports from ./sequencer so the two files don't load each other at runtime.

import type { FetchLike, OutreachLead, PushResult } from "./sequencer";

export const INSTANTLY_BASE = "https://api.instantly.ai/api/v2";
const BATCH = 100; // the API takes 1000; small batches keep a failure contained

/** Instantly campaign status codes (API v2). */
const STATUS_LABEL: Record<number, string> = {
  0: "draft",
  1: "active",
  2: "paused",
  3: "completed",
  4: "running subsequences",
  [-1]: "accounts unhealthy",
  [-2]: "bounce protection on",
  [-99]: "account suspended",
};
export function instantlyStatusLabel(s: unknown): string | undefined {
  if (typeof s !== "number") return typeof s === "string" ? s : undefined;
  return STATUS_LABEL[s] ?? `status ${s}`;
}

export interface InstantlyLead {
  email: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  company_name?: string;
  website?: string;
  custom_variables?: Record<string, string>;
}

export function toInstantlyLead(l: OutreachLead): InstantlyLead {
  const vars: Record<string, string> = { ...l.vars };
  if (l.location) vars.location = l.location;
  const out: InstantlyLead = { email: l.email, custom_variables: vars };
  if (l.firstName) out.first_name = l.firstName;
  if (l.lastName) out.last_name = l.lastName;
  if (l.phone) out.phone = l.phone;
  if (l.company) out.company_name = l.company;
  if (l.website) out.website = l.website;
  return out;
}

const scrub = (msg: string, key: string) => (key ? msg.split(key).join("***") : msg);

function httpError(status: number, message?: string): string {
  const hint =
    status === 401 ? " (check the API key)"
    : status === 403 ? " (the API key needs the leads and campaigns scopes)"
    : status === 404 ? " (check the campaign id)"
    : status === 402 ? " (plan limit reached)"
    : status === 429 ? " (rate limited; try again in a minute)"
    : "";
  const detail = message ? `: ${message.slice(0, 160)}` : "";
  return `Instantly HTTP ${status}${hint}${detail}`;
}

async function errorMessage(res: { json(): Promise<unknown> }): Promise<string | undefined> {
  const body = (await res.json().catch(() => null)) as { message?: unknown; error?: unknown } | null;
  const m = body?.message ?? body?.error;
  return typeof m === "string" ? m : undefined;
}

/** PURE apart from the injected fetch. Push leads in batches; never throws. */
export async function pushLeadsToInstantly(
  leads: OutreachLead[],
  opts: { key: string; campaignId: string; fetchImpl?: FetchLike; verify?: boolean },
): Promise<PushResult> {
  const out: PushResult = { ok: true, provider: "instantly", added: 0, skipped: 0, skippedEmails: [], failedEmails: [], errors: [] };
  const f = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  for (let i = 0; i < leads.length; i += BATCH) {
    const batch = leads.slice(i, i + BATCH);
    const sent = batch.map((l) => l.email.toLowerCase());
    try {
      const res = await f(`${INSTANTLY_BASE}/leads/add`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.key}` },
        body: JSON.stringify({
          campaign_id: opts.campaignId,
          leads: batch.map(toInstantlyLead),
          skip_if_in_workspace: true,
          verify_leads_on_import: Boolean(opts.verify),
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(httpError(res.status, await errorMessage(res)));
      const data = (await res.json().catch(() => ({}))) as { leads_uploaded?: number; created_leads?: { email?: string | null }[] };
      let created: Set<string>;
      if (Array.isArray(data.created_leads)) {
        created = new Set(data.created_leads.map((c) => (c?.email ?? "").toLowerCase()).filter(Boolean));
      } else if (data.leads_uploaded === batch.length) {
        created = new Set(sent);
      } else if (data.leads_uploaded === 0) {
        created = new Set();
      } else {
        // Some went in, but Instantly didn't say which. Don't guess: leave them unpushed for a person to check.
        throw new Error(`Instantly accepted ${data.leads_uploaded ?? "an unknown number"} of ${batch.length} but did not say which; check the campaign before retrying`);
      }
      for (const e of sent) {
        if (created.has(e)) out.added++;
        else { out.skipped++; out.skippedEmails.push(e); }
      }
    } catch (e) {
      out.ok = false;
      out.errors.push(scrub((e as Error).message, opts.key));
      out.failedEmails.push(...sent);
    }
  }
  return out;
}

/** Check the key + campaign by reading the campaign. Never throws, never returns the key. */
export async function probeInstantly(opts: { key: string; campaignId: string; fetchImpl?: FetchLike }): Promise<{ ok: boolean; campaignName?: string; status?: string; error?: string }> {
  try {
    const f = opts.fetchImpl ?? (fetch as unknown as FetchLike);
    const res = await f(`${INSTANTLY_BASE}/campaigns/${encodeURIComponent(opts.campaignId)}`, {
      headers: { authorization: `Bearer ${opts.key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, error: scrub(httpError(res.status, await errorMessage(res)), opts.key) };
    const data = (await res.json().catch(() => ({}))) as { name?: string; status?: unknown };
    return { ok: true, campaignName: data.name, status: instantlyStatusLabel(data.status) };
  } catch (e) {
    return { ok: false, error: scrub((e as Error).message, opts.key) };
  }
}
