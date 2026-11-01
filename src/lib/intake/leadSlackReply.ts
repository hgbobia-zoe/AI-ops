// Web lead → Slack thread reply. Every website lead lands in #new-leads as a Zapier "New Web form Submission"
// post. Once Goodshuffle CONFIRMS the lead's project (the /api/gs/intake-result callback), Viktor replies IN
// THAT POST'S THREAD: received, project created, here is the link. So the whole team sees the same thing in
// the same place, and nobody re-creates the project by hand.
//
// How the post is found: read the channel's recent history and match the lead's email (Slack wraps it as
// <mailto:x|x>) or its 10-digit phone. Only posts from shortly before the lead was recorded count (the Zap
// posts to Slack first, then sends the lead to us), with a 3-day lookback for leads that are backfilled late.
//
// Exactly once: sales_intake.slack_reply_at is claimed with a conditional UPDATE before posting (released if
// the post fails), and slack_reply_ts records which post was answered so two intakes for the same lead never
// reply twice in one thread. Two triggers share this code: an immediate attempt from intake-result (with a
// couple of short retries) and a 15-minute sweep on the runtime clock that catches anything missed. A lead
// with no matching post is simply left alone (nothing to reply under), never a top-level post.
//
// Needs the Viktor bot token with channels:history + chat:write (and channels:join if he was never invited).
// Degrades honestly: without them nothing is posted and the sweep reports why.

import { getDb } from "@/lib/db";
import { getIntake } from "./store";
import type { Intake } from "./types";
import {
  slackBotConfigured,
  slackConversationsHistory,
  slackJoinChannel,
  slackPostAs,
  type SlackMessage,
} from "@/lib/notify/slack";
import { BOTS } from "@/lib/notify/aiBots";

/** The #new-leads channel ID. An ID, not the name: reading history needs the ID, and turning a name into an
 *  ID needs the channels:read scope, which the Viktor app does not have (live 2026-11-01: channel_not_found). */
export const NEW_LEADS_CHANNEL_ID = "C09FMGDJE13";

/** The leads channel. Override with SLACK_CHANNEL_NEW_LEADS (preferably an id). */
export function newLeadsChannel(): string {
  return process.env.SLACK_CHANNEL_NEW_LEADS?.trim() || NEW_LEADS_CHANNEL_ID;
}

/** Lookback for a lead's post, relative to when the lead was recorded. */
const LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
/** The post can trail the lead slightly (clock skew, Zap step order changes). */
const LEAD_SLACK_SKEW_MS = 10 * 60 * 1000;
/** The sweep only retries leads whose project was created within this window. */
const SWEEP_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

/** A lead from an outside source (website, Yelp, ...). In-app intakes are "manual" and have no Slack post. */
export function isWebLead(i: Intake): boolean {
  return !!i.source && i.source !== "manual";
}

function phoneDigits(s: string): string {
  const d = s.replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
}

/** Every 10-digit phone number written in a message ("3173081889", "(317) 308-1889", "+1 317 308 1889"). */
function phonesIn(text: string): string[] {
  return (text.match(/\+?[\d().\s-]{10,}/g) ?? []).map(phoneDigits).filter(Boolean);
}

/** Pure: the newest post that is this lead's form submission, or null. Matches the email first, then the
 *  phone; only posts from [recordedAt - 3 days, recordedAt + 10 min] count. */
export function findLeadPost(
  messages: SlackMessage[],
  lead: { email: string; phone: string; recordedAt: string },
): SlackMessage | null {
  const email = lead.email.trim().toLowerCase();
  const phone = phoneDigits(lead.phone);
  if (!email && !phone) return null;
  const at = Date.parse(lead.recordedAt);
  const lo = Number.isFinite(at) ? at - LOOKBACK_MS : -Infinity;
  const hi = Number.isFinite(at) ? at + LEAD_SLACK_SKEW_MS : Infinity;
  const hits = messages.filter((m) => {
    const ms = Number(m.ts) * 1000;
    if (!(ms >= lo && ms <= hi)) return false;
    const text = m.text.toLowerCase();
    if (email && text.includes(email)) return true;
    return !!phone && phonesIn(m.text).includes(phone);
  });
  hits.sort((a, b) => Number(b.ts) - Number(a.ts));
  return hits[0] ?? null;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The thread reply. House style: short, natural, no dashes, no emoji. */
export function leadReplyText(i: Intake): string {
  const name = esc(`${i.firstName} ${i.lastName}`.trim() || i.email || "this lead");
  const url = i.gsProjectUrl || `https://pro.goodshuffle.com/app/project/detail?id=${i.gsProjectId}`;
  return `Received. I created the Goodshuffle project for ${name}. Here is the link: <${url}|Project ${i.gsProjectId}>`;
}

export type LeadReplyStatus = "posted" | "already" | "not_found" | "skipped" | "error";
export interface LeadReplyResult {
  status: LeadReplyStatus;
  detail?: string;
  threadTs?: string;
}

function claim(intakeId: string, threadTs: string): boolean {
  const now = new Date().toISOString();
  const r = getDb()
    .prepare("UPDATE sales_intake SET slack_reply_at = ?, slack_reply_ts = ? WHERE id = ? AND slack_reply_at IS NULL")
    .run(now, threadTs, intakeId);
  return r.changes === 1;
}

function release(intakeId: string): void {
  getDb().prepare("UPDATE sales_intake SET slack_reply_at = NULL, slack_reply_ts = NULL WHERE id = ?").run(intakeId);
}

function alreadyReplied(intakeId: string): boolean {
  const r = getDb().prepare("SELECT slack_reply_at FROM sales_intake WHERE id = ?").get(intakeId) as { slack_reply_at: string | null } | undefined;
  return !!r?.slack_reply_at;
}

function threadAlreadyAnswered(threadTs: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM sales_intake WHERE slack_reply_ts = ? LIMIT 1").get(threadTs);
}

/** Reply for one intake given an already-read channel history. Idempotent. */
export async function replyForIntake(i: Intake, messages: SlackMessage[]): Promise<LeadReplyResult> {
  if (!i.gsProjectId) return { status: "skipped", detail: "no project yet" };
  if (!isWebLead(i)) return { status: "skipped", detail: "not a web lead" };
  if (alreadyReplied(i.id)) return { status: "already" };
  const post = findLeadPost(messages, { email: i.email, phone: i.phone, recordedAt: i.createdAt });
  if (!post) return { status: "not_found" };
  // Another intake for the same person already answered this post (a resubmission): mark this one done too.
  if (threadAlreadyAnswered(post.ts)) {
    claim(i.id, post.ts);
    return { status: "already", threadTs: post.ts };
  }
  if (!claim(i.id, post.ts)) return { status: "already" };
  const sent = await slackPostAs(newLeadsChannel(), BOTS.ops, leadReplyText(i), { threadTs: post.ts });
  if (!sent.ok) {
    release(i.id);
    return { status: "error", detail: sent.error ?? "post failed" };
  }
  return { status: "posted", threadTs: post.ts };
}

/** Read the leads channel (joining it once if Viktor is not a member). */
async function readLeadsChannel(): Promise<{ ok: boolean; messages: SlackMessage[]; error?: string }> {
  const ch = newLeadsChannel();
  let r = await slackConversationsHistory(ch, 200);
  if (!r.ok && r.error === "not_in_channel") {
    const j = await slackJoinChannel(ch);
    if (j.ok) r = await slackConversationsHistory(ch, 200);
  }
  return { ok: r.ok, messages: r.messages, error: r.error };
}

/** Reply for one intake now (reads the channel itself). Used right after the project is confirmed. */
export async function replyToLeadPost(intakeId: string): Promise<LeadReplyResult> {
  const i = getIntake(intakeId);
  if (!i) return { status: "skipped", detail: "intake not found" };
  if (!i.gsProjectId || !isWebLead(i)) return { status: "skipped" };
  if (alreadyReplied(i.id)) return { status: "already" };
  if (!slackBotConfigured()) return { status: "skipped", detail: "no Slack bot token" };
  const h = await readLeadsChannel();
  if (!h.ok) return { status: "error", detail: `history: ${h.error ?? "unknown"}` };
  return replyForIntake(i, h.messages);
}

/** Fire-and-forget from intake-result: try now, then twice more in case the Slack post lands late. The
 *  sweep is the backstop if all three miss. Never throws. */
export function replyToLeadPostSoon(intakeId: string, delaysMs: number[] = [0, 20_000, 60_000]): void {
  const attempt = async (n: number): Promise<void> => {
    if (n >= delaysMs.length) return;
    await new Promise((r) => setTimeout(r, delaysMs[n]));
    const r = await replyToLeadPost(intakeId).catch((): LeadReplyResult => ({ status: "error" }));
    if (r.status === "not_found" || r.status === "error") await attempt(n + 1);
  };
  void attempt(0);
}

/** Runtime-clock sweep: web leads with a confirmed project in the last 2 days and no reply yet. One history
 *  read covers them all. Never throws. */
export async function runLeadSlackReplySweep(now: number = Date.now()): Promise<{ ok: boolean; detail: string }> {
  const cutoff = new Date(now - SWEEP_WINDOW_MS).toISOString();
  const ids = getDb()
    .prepare(
      `SELECT id FROM sales_intake
        WHERE gs_project_id IS NOT NULL AND gs_project_id != ''
          AND slack_reply_at IS NULL
          AND source IS NOT NULL AND source != 'manual'
          AND completed_at >= ?
        ORDER BY completed_at LIMIT 25`,
    )
    .all(cutoff) as { id: string }[];
  if (!ids.length) return { ok: true, detail: "no lead waiting for a Slack reply" };
  if (!slackBotConfigured()) return { ok: true, detail: `${ids.length} waiting, no Slack bot token` };
  const h = await readLeadsChannel();
  if (!h.ok) return { ok: false, detail: `could not read #${newLeadsChannel()}: ${h.error ?? "unknown"}` };
  const counts: Record<LeadReplyStatus, number> = { posted: 0, already: 0, not_found: 0, skipped: 0, error: 0 };
  for (const { id } of ids) {
    const i = getIntake(id);
    if (!i) continue;
    const r = await replyForIntake(i, h.messages).catch((): LeadReplyResult => ({ status: "error" }));
    counts[r.status]++;
  }
  return {
    ok: counts.error === 0,
    detail: `${counts.posted} replied, ${counts.not_found} with no matching post, ${counts.error} failed`,
  };
}
