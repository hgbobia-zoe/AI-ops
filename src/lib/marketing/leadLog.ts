// Marketing lead log: every lead post from Slack #new-leads, saved into the app for good, plus the read that
// merges it with sales_intake for the scoreboard.
//
// Why save it: Slack's free plan hides posts older than 90 days, a rolling window, so a lead not saved here
// is gone from Slack history for good. The first sync walks all of the channel Slack still shows; after that
// each sync reads only new posts (with a day of overlap for late posts). Saving is idempotent (keyed by the
// Slack post ts). The raw post text is kept so the rows can be re-read if the parsing rules improve.
//
// Needs the Viktor bot token with channels:history (already used for the #new-leads thread replies).

import { getDb } from "@/lib/db/index";
import { slackBotConfigured, slackConversationsHistoryPage, slackJoinChannel, type SlackMessage } from "@/lib/notify/slack";
import { newLeadsChannel } from "@/lib/intake/leadSlackReply";
import { parseLeadPost } from "./slackLeads";
import { isTestLead, leadChannel, type LeadRecord } from "./leadSources";

export const LEAD_LOG_JOB_KEY = "marketing-lead-log";
const OVERLAP_SECONDS = 24 * 60 * 60;
const MAX_PAGES = 200; // 200 posts a page; far more than the channel holds

export interface LeadLogSyncResult {
  ok: boolean;
  detail: string;
  scanned: number;
  added: number;
}

function latestSavedTs(): string | null {
  const r = getDb().prepare("SELECT slack_ts FROM marketing_inbound_leads ORDER BY CAST(slack_ts AS REAL) DESC LIMIT 1").get() as
    | { slack_ts: string }
    | undefined;
  return r?.slack_ts ?? null;
}

function save(messages: SlackMessage[]): number {
  const db = getDb();
  const ins = db.prepare(
    `INSERT OR IGNORE INTO marketing_inbound_leads
       (id, slack_ts, received_at, channel, name, email, phone, ref, is_test, raw_text, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const now = new Date().toISOString();
  let added = 0;
  const tx = db.transaction((ms: SlackMessage[]) => {
    for (const m of ms) {
      const p = parseLeadPost(m);
      if (!p) continue;
      const r = ins.run(`slack:${p.slackTs}`, p.slackTs, p.receivedAt, p.channel, p.name, p.email, p.phone, p.ref, p.isTest ? 1 : 0, m.text, now);
      added += r.changes;
    }
  });
  tx(messages);
  return added;
}

/** Read #new-leads from Slack and save any lead posts not saved yet. Never throws. */
export async function syncLeadLogFromSlack(opts: { full?: boolean } = {}): Promise<LeadLogSyncResult> {
  if (!slackBotConfigured()) return { ok: false, detail: "no Slack bot token, lead log not synced", scanned: 0, added: 0 };
  const channel = newLeadsChannel();
  const latest = opts.full ? null : latestSavedTs();
  const oldest = latest ? String(Math.max(0, Number(latest) - OVERLAP_SECONDS)) : undefined;

  let cursor: string | undefined;
  let scanned = 0;
  let added = 0;
  let joined = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await slackConversationsHistoryPage(channel, { oldest, cursor });
    if (!r.ok) {
      if (r.error === "not_in_channel" && !joined) {
        joined = true;
        const j = await slackJoinChannel(channel);
        if (j.ok) { page--; continue; }
      }
      return { ok: false, detail: `could not read #new-leads: ${r.error ?? "unknown"} (saved ${added} so far)`, scanned, added };
    }
    scanned += r.messages.length;
    added += save(r.messages);
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  const scope = latest ? "new posts" : "all of #new-leads Slack still shows";
  return { ok: true, detail: `read ${scanned} posts (${scope}), saved ${added} new leads`, scanned, added };
}

/** Every saved Slack lead, oldest first. */
export function listSavedSlackLeads(): LeadRecord[] {
  const rows = getDb()
    .prepare("SELECT received_at, channel, name, email, phone, is_test FROM marketing_inbound_leads ORDER BY received_at ASC")
    .all() as { received_at: string; channel: string; name: string | null; email: string | null; phone: string | null; is_test: number }[];
  return rows.map((r) => ({
    receivedAt: r.received_at,
    channel: r.channel,
    name: r.name ?? "",
    email: r.email ?? "",
    phone: r.phone ?? "",
    isTest: r.is_test === 1,
  }));
}

/** Every lead a Zap sent to /api/intake/lead (sales-entered intakes are left out). Read only. */
export function listIntakeLeads(): LeadRecord[] {
  const rows = getDb()
    .prepare("SELECT created_at, source, first_name, last_name, email, phone, sales_notes FROM sales_intake ORDER BY created_at ASC")
    .all() as {
      created_at: string; source: string | null; first_name: string | null; last_name: string | null;
      email: string | null; phone: string | null; sales_notes: string | null;
    }[];
  const out: LeadRecord[] = [];
  for (const r of rows) {
    const ch = leadChannel(r.source);
    if (!ch) continue;
    const name = `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim();
    const email = (r.email ?? "").trim().toLowerCase();
    out.push({
      receivedAt: r.created_at,
      channel: ch.key,
      name,
      email,
      phone: r.phone ?? "",
      isTest: isTestLead({ name, email, message: r.sales_notes ?? "" }),
    });
  }
  return out;
}

/** Both sources together; the scoreboard's repeat rule counts a lead seen in both once. */
export function listAllInboundLeads(): LeadRecord[] {
  return [...listSavedSlackLeads(), ...listIntakeLeads()];
}

export function savedLeadCount(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM marketing_inbound_leads").get() as { n: number }).n;
}
