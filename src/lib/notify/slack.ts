// Slack notifications via Incoming Webhooks. Two independent channels, each a no-op that reports
// `skipped` when unset; neither ever throws:
//   • DELIVERY / OPS  → slackNotify()      → SLACK_WEBHOOK_URL (the existing dispatch channel)
//   • CUSTOMER ALERTS → slackNotifyAlert() → the "alerts.slackWebhook" secret, else
//                                            SLACK_ALERT_WEBHOOK_URL — a SEPARATE channel, on purpose.

import { getSecret } from "@/lib/secrets";

export interface SlackResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

async function post(url: string | null | undefined, text: string): Promise<SlackResult> {
  if (!url) return { ok: false, skipped: true };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return res.ok ? { ok: true } : { ok: false, error: `slack ${res.status}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export function slackConfigured(): boolean {
  return Boolean(process.env.SLACK_WEBHOOK_URL);
}

export async function slackNotify(text: string): Promise<SlackResult> {
  return post(process.env.SLACK_WEBHOOK_URL, text);
}

/** The customer-alerts webhook — a DIFFERENT channel from delivery. Admin secret first, env fallback.
 *  Deliberately does NOT fall back to the delivery webhook: an empty config skips (no misrouting). */
function alertWebhook(): string | null {
  try {
    const secret = getSecret("alerts.slackWebhook");
    if (secret) return secret;
  } catch {
    // secrets store unavailable (e.g. non-DB context) — fall through to env
  }
  return process.env.SLACK_ALERT_WEBHOOK_URL ?? null;
}

export function slackAlertConfigured(): boolean {
  return Boolean(alertWebhook());
}

export async function slackNotifyAlert(text: string): Promise<SlackResult> {
  return post(alertWebhook(), text);
}

// ── Direct messages (Slack bot token) ───────────────────────────────────────────
// Webhooks can only post to one channel — they CANNOT DM a person. A true per-person DM needs a bot token
// (SLACK_BOT_TOKEN, scopes chat:write + users:read.email). This stays DORMANT until the token is set: every
// function below returns `skipped` without one, so the caller falls back to a channel post. We resolve the
// recipient by email (users.lookupByEmail) — the app does not yet store user emails, so this path only lights
// up once a bot token AND user emails both exist. Never throws.
export function slackBotConfigured(): boolean {
  return Boolean(process.env.SLACK_BOT_TOKEN);
}

async function slackApi(method: string, body: Record<string, unknown>): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return { ok: false, error: "no_bot_token" };
  try {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as Record<string, unknown>;
    return data.ok === true ? { ok: true, data } : { ok: false, error: String(data.error ?? `slack ${res.status}`) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// chat.postMessage / conversations.join want a channel ID, and a channel NAME only resolves when the bot can
// see it. Cache name→ID per process so we don't list on every post. Needs channels:read.
const channelIdCache = new Map<string, string>();
async function resolveChannelId(nameOrId: string): Promise<string | null> {
  const v = nameOrId.replace(/^#/, "").trim();
  if (/^[CGD][A-Z0-9]{6,}$/.test(v)) return v; // already an ID
  if (channelIdCache.has(v)) return channelIdCache.get(v)!;
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const r = await slackApi("conversations.list", { exclude_archived: true, types: "public_channel,private_channel", limit: 1000, ...(cursor ? { cursor } : {}) });
    if (!r.ok) return null; // e.g. missing_scope (channels:read) — caller falls back
    for (const c of (r.data?.channels as { id: string; name: string }[] | undefined) ?? []) {
      channelIdCache.set(c.name, c.id);
      if (c.name === v) return c.id;
    }
    cursor = (r.data?.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
    if (!cursor) break;
  }
  return channelIdCache.get(v) ?? null;
}

/** DM a person by their (work) email. Returns skipped when no bot token is set, or a clear error when the
 *  email maps to no Slack user — so the caller can fall back to a channel post. */
export async function slackDmByEmail(email: string, text: string): Promise<SlackResult> {
  if (!slackBotConfigured()) return { ok: false, skipped: true };
  const clean = email.trim();
  if (!clean) return { ok: false, error: "no_email" };
  const lookup = await slackApi("users.lookupByEmail", { email: clean });
  if (!lookup.ok) return { ok: false, error: `lookup: ${lookup.error}` };
  const userId = (lookup.data?.user as { id?: string } | undefined)?.id;
  if (!userId) return { ok: false, error: "user_not_found" };
  const sent = await slackApi("chat.postMessage", { channel: userId, text });
  return sent.ok ? { ok: true } : { ok: false, error: `post: ${sent.error}` };
}

/** Post a message to a Slack channel/DM (optionally in a thread) AS THE BOT (Viktor) — used to deliver
 *  Viktor's answer back into the thread it was asked in. Skipped (no-op) when no bot token is set. */
export async function slackPostMessage(channel: string, text: string, threadTs?: string | null): Promise<SlackResult> {
  if (!slackBotConfigured()) return { ok: false, skipped: true };
  const ch = channel.trim();
  const msg = text.trim();
  if (!ch || !msg) return { ok: false, error: "missing_channel_or_text" };
  const body: Record<string, unknown> = { channel: ch, text: msg };
  if (threadTs) body.thread_ts = threadTs;
  const sent = await slackApi("chat.postMessage", body);
  return sent.ok ? { ok: true } : { ok: false, error: `post: ${sent.error}` };
}

// ── Reads (conversations.history / conversations.replies) ────────────────────────
// Viktor is conversation-aware: to understand "silence THIS alert" he must read the thread he's in —
// including the alert posts he made from background jobs, which are NOT session events. These reads need the
// history scopes (channels:history / groups:history / im:history / mpim:history). They DEGRADE HONESTLY:
// without a bot token, without the scope (missing_scope), or when the bot isn't in the channel
// (not_in_channel), they return { ok:false } and the caller falls back to the in-DB transcript. Never throw.

/** A normalized Slack message from a history/replies read. `botId` set → an app/bot posted it (incl. Viktor's
 *  own posts + his persona alert posts); `username` is the persona display name if one was used. */
export interface SlackMessage {
  ts: string; //        Slack message ts (epoch seconds as a string, e.g. "1699999999.000100")
  user: string | null; // posting user id, or null for a bot/app message
  botId: string | null; // bot_id when an app/bot posted (so we can label it as Viktor)
  username: string | null; // persona display-name override (slackPostAs sets this), if any
  text: string;
}

export interface SlackReadResult {
  ok: boolean;
  messages: SlackMessage[];
  skipped?: boolean; // no bot token — read not attempted
  error?: string; //   e.g. missing_scope / not_in_channel — caller falls back to the DB transcript
}

function toSlackMessages(data: Record<string, unknown> | undefined): SlackMessage[] {
  const raw = (data?.messages as Record<string, unknown>[] | undefined) ?? [];
  return raw
    .map((m) => ({
      ts: typeof m.ts === "string" ? m.ts : "",
      user: typeof m.user === "string" ? m.user : null,
      botId: typeof m.bot_id === "string" ? m.bot_id : null,
      username: typeof m.username === "string" ? m.username : null,
      text: typeof m.text === "string" ? m.text : "",
    }))
    .filter((m) => m.ts && (m.text || m.botId || m.user));
}

/** Read a thread's replies (the parent + its replies) for context. Returns the messages oldest-first as Slack
 *  provides them. Honest degrade: skipped without a token; { ok:false } on missing scope / not-in-channel. */
export async function slackConversationsReplies(channel: string, threadTs: string, limit = 50): Promise<SlackReadResult> {
  if (!slackBotConfigured()) return { ok: false, skipped: true, messages: [] };
  const ch = channel.trim();
  const ts = threadTs.trim();
  if (!ch || !ts) return { ok: false, error: "missing_channel_or_ts", messages: [] };
  const id = (await resolveChannelId(ch)) ?? ch;
  const r = await slackApi("conversations.replies", { channel: id, ts, limit: Math.min(200, Math.max(1, limit)) });
  if (!r.ok) return { ok: false, error: r.error, messages: [] };
  return { ok: true, messages: toSlackMessages(r.data) };
}

/** Read a channel's most recent messages (not thread-scoped). Same honest-degrade contract as replies. Used
 *  only as a secondary context source; the thread read is the primary one for Viktor. */
export async function slackConversationsHistory(channel: string, limit = 20): Promise<SlackReadResult> {
  if (!slackBotConfigured()) return { ok: false, skipped: true, messages: [] };
  const ch = channel.trim();
  if (!ch) return { ok: false, error: "missing_channel", messages: [] };
  const id = (await resolveChannelId(ch)) ?? ch;
  const r = await slackApi("conversations.history", { channel: id, limit: Math.min(200, Math.max(1, limit)) });
  if (!r.ok) return { ok: false, error: r.error, messages: [] };
  // history returns newest-first; return oldest-first for a natural transcript.
  return { ok: true, messages: toSlackMessages(r.data).reverse() };
}

/** Have the bot join a public channel (needs channels:join). Used before a history read in a channel the bot
 *  was never invited to. Skipped without a bot token. Never throws. */
export async function slackJoinChannel(channel: string): Promise<SlackResult> {
  if (!slackBotConfigured()) return { ok: false, skipped: true };
  const id = (await resolveChannelId(channel)) ?? channel.trim();
  const r = await slackApi("conversations.join", { channel: id });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/** A bot's Slack identity: the display name + icon it posts under. One Slack app (Viktor) posts AS each bot
 *  via chat:write.customize, so the team sees "Scheduling Bot", "Sales Bot", etc. without a separate app per
 *  bot. When that scope isn't granted Slack simply ignores name/icon and posts as the app — never an error. */
export interface BotPersona {
  name: string;
  icon: string; // a Slack :emoji: shortcode
}

/** Post to a channel AS a named bot persona (custom display name + icon). Skipped when no bot token is set.
 *  `opts.blocks` renders a designed Block Kit card; `text` is still passed as the notification/fallback text
 *  (and what shows if blocks can't render), so always provide a readable `text`. */
export async function slackPostAs(
  channel: string,
  persona: BotPersona,
  text: string,
  opts?: { blocks?: unknown[]; threadTs?: string | null },
): Promise<SlackResult> {
  if (!slackBotConfigured()) return { ok: false, skipped: true };
  const msg = text.trim();
  if (!channel.trim() || !msg) return { ok: false, error: "missing_channel_or_text" };
  // Resolve the channel NAME to an ID (falls back to the raw value if we can't list), then post.
  const ch = (await resolveChannelId(channel)) ?? channel.trim();
  const body: Record<string, unknown> = { channel: ch, text: msg, username: persona.name, icon_emoji: persona.icon };
  if (opts?.blocks?.length) body.blocks = opts.blocks;
  if (opts?.threadTs) body.thread_ts = opts.threadTs;
  let sent = await slackApi("chat.postMessage", body);
  // The bot isn't a member yet → self-join the (public) channel once and retry, so we don't need a manual
  // /invite in every channel. Needs channels:join; if that scope is missing the join fails and we fall back.
  if (!sent.ok && sent.error === "not_in_channel") {
    const joined = await slackApi("conversations.join", { channel: ch });
    if (joined.ok) sent = await slackApi("chat.postMessage", body);
  }
  return sent.ok ? { ok: true } : { ok: false, error: `post: ${sent.error}` };
}

/**
 * Narrate an AI-EMPLOYEE action in Slack so a human sees WHAT it did and WHY and can override it. House rule
 * (the user's): an AI employee never acts silently. Posts AS VIKTOR (the bot) to the AI-activity channel
 * (SLACK_AI_CHANNEL) when the bot token + channel are set; otherwise FALLS BACK to the ops webhook so the
 * action is still announced — never silent. Never throws. The caller passes the full message (which employee,
 * what, why).
 *
 * NOTE: prefer `botAnnounce(bot, text)` (src/lib/notify/aiBots.ts) for new code — it routes to the bot's OWN
 * domain channel and posts under its OWN persona. This stays for callers that just want the generic AI channel.
 */
export async function viktorAnnounce(text: string): Promise<SlackResult> {
  const channel = process.env.SLACK_AI_CHANNEL?.trim();
  if (channel && slackBotConfigured()) {
    const r = await slackPostMessage(channel, text);
    if (r.ok) return r; // posted as Viktor in the AI-activity channel
    // bot token present but post failed → fall through to the webhook so the action is still surfaced
  }
  return slackNotify(text);
}
