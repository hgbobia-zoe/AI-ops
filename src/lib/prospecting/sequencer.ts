// Prospecting — cold-email sequencer bridge. Tier B email steps are worked from a DEDICATED cold-email
// tool on a separate warmed domain (deliverability hygiene — never blast from the primary domain). Two
// paths: a CSV export that every tool (Instantly / Smartlead / Apollo / lemlist) imports, and an
// optional direct API push (DORMANT until SEQUENCER_API_KEY is set). We never send from here; the tool
// owns sending, warmup, throttling and unsubscribe handling.

import type { StoredTask } from "./store";

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

/** Build a CSV string from sequencer rows. Header matches the common cold-email import format. */
export function toCsv(rows: SequencerRow[]): string {
  const header = ["email", "first_name", "company", "subject", "body", "opportunity", "jurisdiction", "tier", "step"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([r.email, r.firstName, r.company, r.subject, r.body, r.opportunity, r.jurisdiction, r.tier, String(r.step)].map((x) => csvEscape(x ?? "")).join(","));
  }
  return lines.join("\n");
}

export function sequencerConfigured(): boolean {
  return Boolean(process.env.SEQUENCER_API_KEY);
}

export interface PushResult { ok: boolean; skipped?: boolean; pushed?: number; error?: string; provider?: string }

/**
 * Push rows to the configured sequencer. DORMANT unless SEQUENCER_API_KEY (and SEQUENCER_PROVIDER +
 * SEQUENCER_CAMPAIGN_ID) are set. Supports Instantly and Smartlead shapes. Never throws.
 */
export async function pushToSequencer(rows: SequencerRow[]): Promise<PushResult> {
  const key = process.env.SEQUENCER_API_KEY;
  const provider = (process.env.SEQUENCER_PROVIDER || "instantly").toLowerCase();
  const campaign = process.env.SEQUENCER_CAMPAIGN_ID;
  if (!key) return { ok: false, skipped: true, provider };
  if (rows.length === 0) return { ok: true, pushed: 0, provider };
  try {
    if (provider === "instantly") {
      const res = await fetch("https://api.instantly.ai/api/v1/lead/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: key, campaign_id: campaign, leads: rows.map((r) => ({ email: r.email, first_name: r.firstName, company_name: r.company, custom_variables: { opportunity: r.opportunity, jurisdiction: r.jurisdiction } })) }),
        signal: AbortSignal.timeout(30_000),
      });
      return res.ok ? { ok: true, pushed: rows.length, provider } : { ok: false, error: `instantly ${res.status}`, provider };
    }
    if (provider === "smartlead") {
      const res = await fetch(`https://server.smartlead.ai/api/v1/campaigns/${campaign}/leads?api_key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lead_list: rows.map((r) => ({ email: r.email, first_name: r.firstName, company_name: r.company })) }),
        signal: AbortSignal.timeout(30_000),
      });
      return res.ok ? { ok: true, pushed: rows.length, provider } : { ok: false, error: `smartlead ${res.status}`, provider };
    }
    return { ok: false, error: `unknown provider ${provider}`, provider };
  } catch (e) {
    return { ok: false, error: (e as Error).message, provider };
  }
}

/** Turn an email task + its context into a sequencer row (skips tasks with no email). */
export function taskToRow(task: StoredTask, ctx: { email: string | null; firstName: string; company: string; opportunity: string; jurisdiction: string; tier: string }): SequencerRow | null {
  if (task.channel !== "email" || !ctx.email) return null;
  return { email: ctx.email, firstName: ctx.firstName, company: ctx.company, subject: task.subject ?? "", body: task.body ?? "", opportunity: ctx.opportunity, jurisdiction: ctx.jurisdiction, tier: ctx.tier, step: task.stepIndex };
}
