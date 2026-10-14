// Viktor Tier 1 — the SNAPPY, server-side fast path. When a Slack message reaches /api/slack/events, a
// cheap fast model (Haiku, via @/lib/llm) triages it RIGHT HERE, inside the always-on app:
//
//   • a BASIC question (what can you do, how does X work, general platform/FAQ) → answered immediately and
//     posted into the thread as Viktor. No office machine, no waiting on the bridge.
//   • an ACTUAL TASK (anything needing live data, or any action) → left on the bridge for the full Claude
//     Code responder (Tier 2), which has the tools and the approval path. We post a short "on it" ack.
//
// HARD LINE: this tier is READ-ONLY. It only ever produces TEXT. It never executes an action, never writes
// operational data, never raises or decides an approval. Every task flows to Tier 2 and its approval gate,
// so the governing law holds: RULES CALCULATE, AI INTERPRETS. Fail-safe by construction: any error, any
// doubt, any unparseable model output routes to Tier 2 rather than guessing an answer. Never throws.

import { chat, llmConfigured } from "@/lib/llm";
import { humanize } from "@/lib/salesos/outreach";
import { slackBotConfigured, slackPostMessage } from "@/lib/notify/slack";
import { appendEvent, getSession, listSessionEvents, setSessionResult, NEUTRAL_EVENT_KINDS } from "@/lib/ai/sessions";

export type TriageMode = "answer" | "route";

export interface TriageResult {
  mode: TriageMode;
  /** The full answer text when mode === "answer"; null when routing (Tier 2 will answer). */
  answer: string | null;
}

/** What Viktor tells the person while a real task is handed to the capable responder. Deterministic, so a
 *  routing ack never depends on the model and never carries a stray dash/emoji. */
export const ROUTE_ACK = "On it. Let me pull that together and I will reply here in a moment.";

// The triage brief. Viktor's identity + the ONE decision + the strict output contract. Deliberately
// conservative: answer only evergreen, no-data, no-action questions; everything else routes.
export function buildTriageSystem(): string {
  return [
    "You are Viktor, the AI assistant for Zoe Events and Party Rentals, working inside their internal ops",
    "platform (Zoe Dispatch). You are the fast triage layer for a Slack message.",
    "",
    "Decide EXACTLY ONE of two modes and reply with STRICT JSON, nothing else:",
    '  {"mode":"answer","answer":"<your full reply>"}   OR   {"mode":"route","answer":null}',
    "",
    'Choose "answer" ONLY when you can fully and safely answer from general knowledge of what Viktor and',
    "the platform are and do, with NO live company data and NO action. Examples: what can you do, what tools",
    "do you have, how does something work in general, a greeting, a definition.",
    "",
    'Choose "route" for anything that needs CURRENT company data (schedules, routes, who is working, crew',
    "availability, finances, revenue, specific leads, quotes, events, counts, statuses, this week, today) OR",
    'any ACTION (text a crew, send an email, add a note, create a task, change or move anything). When in',
    'any doubt, choose "route". Never invent data. Never promise to do an action yourself.',
    "",
    "When you answer: be natural, short, and plain. Do not use dashes as punctuation. No emojis. Do not claim",
    "to read Confluence. If asked what you can do, cover: answer questions from the app data, set up actions",
    "for approval (a human approves before anything runs), and log feature requests.",
  ].join("\n");
}

/** Parse the model's triage JSON into a safe TriageResult. Tolerates code fences and surrounding prose.
 *  Any malformed / unexpected output FAILS SAFE to routing (so a real question still reaches Tier 2). PURE. */
export function parseTriageResult(raw: string | undefined | null): TriageResult {
  if (!raw) return { mode: "route", answer: null };
  // Pull the first {...} block out of fences/prose.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return { mode: "route", answer: null };
  let obj: { mode?: unknown; answer?: unknown };
  try {
    obj = JSON.parse(raw.slice(start, end + 1)) as typeof obj;
  } catch {
    return { mode: "route", answer: null };
  }
  if (obj.mode === "answer") {
    const answer = typeof obj.answer === "string" ? obj.answer.trim() : "";
    // "answer" with no actual text is not a usable answer — route instead.
    return answer ? { mode: "answer", answer } : { mode: "route", answer: null };
  }
  return { mode: "route", answer: null };
}

/** Call the fast model to triage one message. Returns the parsed result, or a safe "route" on any failure
 *  (LLM unconfigured/errored/timed out). Never throws. */
export async function triageViktorMessage(text: string): Promise<TriageResult> {
  const clean = (text || "").trim();
  if (!clean) return { mode: "route", answer: null };
  if (!llmConfigured()) return { mode: "route", answer: null };
  const res = await chat(
    [
      { role: "system", content: buildTriageSystem() },
      { role: "user", content: clean },
    ],
    { json: true, temperature: 0, maxTokens: 600, timeoutMs: 15000 },
  );
  if (!res.ok || !res.text) return { mode: "route", answer: null };
  return parseTriageResult(res.text);
}

/** Is this session's newest non-neutral event still the unanswered instruction? If something already
 *  responded (Tier 2 claimed/answered, or a prior fast-path run), we must NOT answer again. */
function stillUnanswered(sessionId: string): boolean {
  const latest = listSessionEvents(sessionId, 6).find((e) => !NEUTRAL_EVENT_KINDS.includes(e.kind));
  return latest?.kind === "instruction";
}

/** Record Viktor's fast-path answer on the session timeline so it drops out of the pending queue (Tier 2
 *  will not re-answer) and shows in the Command Center. Mirrors the bridge's result handling. */
function recordAnswer(sessionId: string, answer: string): void {
  setSessionResult(sessionId, { text: answer, type: "question", via: "fast-path" });
  appendEvent(sessionId, { kind: "message", actor: "Viktor (fast path)", label: "Answered from app knowledge (fast path)" });
}

export interface FastPathParams {
  sessionId: string;
  text: string;
  channel: string;
  threadTs: string | null;
}

export type FastPathOutcome = "answered" | "routed" | "skipped";

/** Tier 1 orchestration for one Slack-sourced session. Fire-and-forget from the webhook (the app is a
 *  long-lived Node server on Fly, so a void promise kicked off before the 200 keeps running). Delivers to
 *  Slack FIRST and only records the answer on success, so a failed Slack post leaves the instruction
 *  pending for Tier 2 rather than silently swallowing it. Never throws. */
export async function handleViktorFastPath(params: FastPathParams): Promise<FastPathOutcome> {
  try {
    // Without a bot token we cannot deliver to the thread; leave everything for Tier 2.
    if (!slackBotConfigured() || !params.channel) return "skipped";
    const session = getSession(params.sessionId);
    if (!session) return "skipped";

    const triage = await triageViktorMessage(params.text);

    if (triage.mode === "answer" && triage.answer) {
      // Re-check just before delivering: Tier 2 (or a prior run) may have answered during triage.
      if (!stillUnanswered(params.sessionId)) return "skipped";
      const text = humanize(triage.answer);
      const sent = await slackPostMessage(params.channel, text, params.threadTs);
      if (!sent.ok) return "skipped"; // undelivered — keep it pending for Tier 2, do not record
      recordAnswer(params.sessionId, text);
      return "answered";
    }

    // Routed to Tier 2: a courtesy ack only. Do NOT record a response event — the instruction stays
    // pending so the capable responder picks it up.
    void slackPostMessage(params.channel, ROUTE_ACK, params.threadTs).catch(() => {});
    return "routed";
  } catch {
    return "skipped"; // any failure: Tier 2 still has the pending instruction
  }
}
