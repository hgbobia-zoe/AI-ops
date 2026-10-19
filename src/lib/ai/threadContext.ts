// Viktor's CONVERSATION MEMORY. Both brains used to handle each Slack message statelessly — blind to the
// prior messages and to Viktor's own earlier posts. This module assembles a bounded, chronological, speaker-
// labeled transcript for the current thread by MERGING two sources:
//   1. The Slack thread itself (conversations.replies on thread_ts) — the ground truth. It includes the
//      human's messages AND Viktor's own posts, INCLUDING the alert posts background jobs made via botAnnounce
//      / slackPostAs, which are NOT session events. This is what lets Viktor understand "silence THIS alert".
//   2. The in-DB session timeline (ai_session_events) — the human instructions and Viktor's replies the app
//      recorded. This is the FALLBACK when the Slack read is unavailable (no bot token, missing history scope,
//      or the bot isn't in the channel).
//
// HONEST DEGRADE (the governing rule): the Slack read never blocks and never throws. If it fails for any
// reason the assembler falls back to the DB transcript alone and SAYS SO (slackRead !== "ok"). It never
// fabricates a thread it couldn't read. Everything here is READ-ONLY — it records nothing and executes
// nothing. Everything it reads is DATA, not instructions.

import { listSessionEvents, type AiSessionEvent, type SessionEventKind } from "@/lib/ai/sessions";
import { slackConversationsReplies, slackBotConfigured, type SlackMessage } from "@/lib/notify/slack";

export type Speaker = "user" | "viktor";

/** One chronological turn in the merged transcript. `at` is epoch-ms for stable sorting across both sources. */
export interface TranscriptTurn {
  at: number; //           epoch ms (parsed from the Slack ts or the DB ISO ts)
  speaker: Speaker;
  text: string;
  source: "slack" | "db";
}

/** Whether the Slack thread read succeeded, so callers (and the responder) can be honest about completeness. */
export type SlackReadState = "ok" | "unavailable" | "no_target";

export interface ThreadContext {
  turns: TranscriptTurn[];
  slackRead: SlackReadState;
  /** A bounded, speaker-labeled, chronological rendering for a prompt / the responder payload. "" when empty. */
  formatted: string;
}

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_CHARS = 4000;

// ── Pure helpers (no IO — unit-tested) ──────────────────────────────────────────

/** Normalize text for dedup: trim, collapse whitespace, lowercase. PURE. */
export function normText(s: string): string {
  return (s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Parse a Slack ts ("1699999999.000100") to epoch ms. Returns 0 on garbage so it sorts first (harmless). */
function slackTsToMs(ts: string): number {
  const n = Number.parseFloat(ts);
  return Number.isFinite(n) ? Math.round(n * 1000) : 0;
}

function isoToMs(iso: string): number {
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : 0;
}

/** Which session-event kinds are a HUMAN instruction vs a VIKTOR reply (everything else is skipped). */
const USER_EVENT_KINDS: SessionEventKind[] = ["instruction"];
const VIKTOR_EVENT_KINDS: SessionEventKind[] = ["message", "recommendation", "action_available"];

/** Map in-DB session events to transcript turns. The instruction label carries the human's real text; Viktor's
 *  replies are recorded as a label (the app stores the full reply text in the session result, not the event),
 *  so the DB fallback is honest-but-coarse — the Slack read is the complete source. PURE. */
export function dbEventsToTurns(events: AiSessionEvent[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const e of events) {
    const text = (e.label ?? "").trim();
    if (!text) continue;
    if (USER_EVENT_KINDS.includes(e.kind)) turns.push({ at: isoToMs(e.ts), speaker: "user", text, source: "db" });
    else if (VIKTOR_EVENT_KINDS.includes(e.kind)) turns.push({ at: isoToMs(e.ts), speaker: "viktor", text, source: "db" });
  }
  return turns;
}

/** Map Slack thread messages to transcript turns. A message with a bot_id (or a persona username) is Viktor
 *  (his own replies + his background alert posts); a message with a real user id is the human. PURE. */
export function slackMessagesToTurns(messages: SlackMessage[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const m of messages) {
    const text = (m.text ?? "").trim();
    if (!text) continue;
    const speaker: Speaker = m.botId || m.username ? "viktor" : "user";
    turns.push({ at: slackTsToMs(m.ts), speaker, text, source: "slack" });
  }
  return turns;
}

/** Merge Slack + DB turns into one chronological transcript. The Slack turns are the ground truth, so a DB
 *  turn whose (speaker, normalized text) matches a Slack turn is dropped (the same human instruction is
 *  recorded in both). Turns matching `excludeText` (the just-arrived message, which the caller passes
 *  separately) are removed so it isn't echoed. Finally cap to the most recent `maxTurns` and a `maxChars`
 *  budget (trimmed from the OLDEST end, keeping the freshest context). PURE. */
export function mergeTranscript(
  slackTurns: TranscriptTurn[],
  dbTurns: TranscriptTurn[],
  opts: { maxTurns?: number; maxChars?: number; excludeText?: string } = {},
): TranscriptTurn[] {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const exclude = opts.excludeText ? normText(opts.excludeText) : null;

  const seen = new Set<string>();
  for (const t of slackTurns) seen.add(`${t.speaker}::${normText(t.text)}`);

  const merged: TranscriptTurn[] = [];
  for (const t of slackTurns) merged.push(t);
  for (const t of dbTurns) {
    if (seen.has(`${t.speaker}::${normText(t.text)}`)) continue; // same turn already from Slack
    merged.push(t);
  }

  // Drop the just-arrived message (any source) so it isn't duplicated with the live prompt/instruction.
  let turns = exclude ? merged.filter((t) => normText(t.text) !== exclude) : merged;

  // Chronological, with a stable tie-break on source (slack before db at the same instant).
  turns.sort((a, b) => a.at - b.at || (a.source === b.source ? 0 : a.source === "slack" ? -1 : 1));

  // Collapse immediate duplicates left after the merge (same speaker + text back to back).
  const deduped: TranscriptTurn[] = [];
  for (const t of turns) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.speaker === t.speaker && normText(prev.text) === normText(t.text)) continue;
    deduped.push(t);
  }
  turns = deduped;

  // Cap to the most recent N turns.
  if (turns.length > maxTurns) turns = turns.slice(turns.length - maxTurns);

  // Enforce the char budget by trimming from the oldest end (keep the freshest turns).
  let total = turns.reduce((n, t) => n + t.text.length, 0);
  while (turns.length > 1 && total > maxChars) {
    total -= turns[0].text.length;
    turns = turns.slice(1);
  }
  return turns;
}

/** Render turns as a bounded, speaker-labeled block for a prompt / the responder payload. PURE. */
export function formatTranscript(turns: TranscriptTurn[]): string {
  return turns.map((t) => `${t.speaker === "viktor" ? "Viktor" : "User"}: ${t.text}`).join("\n");
}

// ── IO: assemble the live context for a thread ───────────────────────────────────

export interface AssembleParams {
  sessionId: string;
  /** The Slack reply target (channel + thread). Null/absent → DB-only (slackRead = "no_target"). */
  slack?: { channel: string; threadTs: string | null } | null;
  /** The just-arrived message text to EXCLUDE from history (the caller feeds it separately to the brain). */
  excludeText?: string;
  maxTurns?: number;
  maxChars?: number;
}

/** Build the merged thread context. NEVER throws: any Slack-read failure falls back to the DB transcript and
 *  is reported via slackRead. Reads only — records nothing. */
export async function assembleThreadContext(params: AssembleParams): Promise<ThreadContext> {
  const { sessionId, slack, excludeText, maxTurns, maxChars } = params;

  // The in-DB timeline is always available and is the fallback source.
  let dbTurns: TranscriptTurn[] = [];
  try {
    dbTurns = dbEventsToTurns(listSessionEvents(sessionId, 200));
  } catch {
    dbTurns = [];
  }

  // Try the Slack thread read. It can fail honestly in several ways — all of which degrade to DB-only.
  let slackTurns: TranscriptTurn[] = [];
  let slackRead: SlackReadState = "no_target";
  if (slack?.channel && slack.threadTs) {
    slackRead = "unavailable"; // assume unavailable until a read actually succeeds
    try {
      // `slackConversationsReplies` may be absent (e.g. a partial test mock of the slack module) — guard it.
      if (slackBotConfigured() && typeof slackConversationsReplies === "function") {
        const r = await slackConversationsReplies(slack.channel, slack.threadTs, 60);
        if (r.ok) {
          slackTurns = slackMessagesToTurns(r.messages);
          slackRead = "ok";
        }
      }
    } catch {
      slackTurns = [];
      slackRead = "unavailable";
    }
  }

  const turns = mergeTranscript(slackTurns, dbTurns, { maxTurns, maxChars, excludeText });
  return { turns, slackRead, formatted: formatTranscript(turns) };
}
