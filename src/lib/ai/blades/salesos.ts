// AI Control Plane — Sales OS blade runner (the FIRST real blade wired to the operating layer). It proves
// the architecture end to end on real data: open a session, read the real lost quotes, score them with a
// deterministic rule, record every step on the session timeline, surface a recommendation, and — only
// when the blade's auto-propose is enabled — raise a safe, human-decided action through the EXISTING
// approval path. Nothing executes without a human: RULES CALCULATE, AI INTERPRETS.
//
// Server-only (reads the DB). The scoring is pure and unit-tested in salesos.test.ts.

import { getLostQuotes, type BookingView } from "@/lib/db/repo";
import { todayInOpsTz } from "@/lib/dates";
import { getEmployee } from "@/lib/aiorg/registry";
import { createSession, recordToolRun, appendEvent, setSessionResult, type AiSession } from "@/lib/ai/sessions";
import { proposeFromSession } from "@/lib/ai/propose";
import { getBladeAiConfig } from "@/lib/ai/bladeConfig";

export interface ScoredLostQuote {
  id: string;
  clientName: string;
  eventName: string;
  eventDate: string;
  daysToEvent: number;
  value: number | null;
  score: number;
}

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN;
  return Math.round((b - a) / 86_400_000);
}

/** Score upcoming lost quotes for recovery: nearer events and bigger values rank higher. Deterministic,
 *  honest — an unknown value contributes nothing (never a fabricated number). PURE given `today`. */
export function scoreLostQuotes(rows: BookingView[], today: string, windowDays = 45): ScoredLostQuote[] {
  const out: ScoredLostQuote[] = [];
  for (const b of rows) {
    if (!b.eventDate) continue;
    const d = daysBetween(today, b.eventDate);
    if (!Number.isFinite(d) || d < 0 || d > windowDays) continue; // only recoverable, upcoming events
    // Proximity: 0..1 (sooner = higher). Value: log-scaled so a few huge quotes don't dominate entirely.
    const proximity = (windowDays - d) / windowDays;
    const valueScore = b.grandTotal && b.grandTotal > 0 ? Math.min(1, Math.log10(b.grandTotal) / 5) : 0;
    const score = Math.round((proximity * 0.6 + valueScore * 0.4) * 1000) / 1000;
    out.push({ id: b.bookingId, clientName: b.clientName, eventName: b.eventName, eventDate: b.eventDate, daysToEvent: d, value: b.grandTotal, score });
  }
  out.sort((a, b) => b.score - a.score || a.daysToEvent - b.daysToEvent);
  return out;
}

const money = (n: number | null): string => (n == null ? "unknown value" : "$" + Math.round(n).toLocaleString("en-US"));

/** Run the Sales OS "Lost Quote Recovery" playbook as a real AI session. Returns the session (left running
 *  so the operator can instruct it further or act on its recommendation). */
export function runLostQuoteRecovery(opts: { actor?: string; windowDays?: number; topN?: number } = {}): AiSession {
  const windowDays = opts.windowDays ?? 45;
  const topN = opts.topN ?? 6;
  const today = todayInOpsTz();
  const emp = getEmployee("lost-quote");
  const owner = emp?.owner;

  const session = createSession({
    agentId: "lost-quote",
    blade: "salesos",
    owner,
    startedBy: opts.actor,
    title: "Lost Quote Recovery",
    objective: `Recover the highest-value lost quotes with events within the next ${windowDays} days.`,
    provider: "session-bridge",
  });
  const sid = session.id;

  // 1) Read the real lost quotes.
  let rows: BookingView[] = [];
  try {
    rows = getLostQuotes();
  } catch {
    rows = [];
  }
  recordToolRun(sid, { toolId: "read_lost_quotes", category: "DATA", perm: "READ", status: "ok", result: { count: rows.length } });
  appendEvent(sid, { kind: "step", label: `Retrieved ${rows.length} historical lost quotes.` });

  // 2) Score and filter to upcoming, recoverable events.
  const scored = scoreLostQuotes(rows, today, windowDays);
  recordToolRun(sid, { toolId: "score_recovery", category: "ANALYSIS", perm: "ANALYZE", status: "ok", result: { candidates: scored.length } });
  appendEvent(sid, {
    kind: "step",
    label: `Filtered to ${scored.length} opportunities with events within ${windowDays} days, scored on event proximity and quote value.`,
  });

  const top = scored.slice(0, topN);

  // 3) Recommendation.
  if (top.length === 0) {
    appendEvent(sid, { kind: "recommendation", label: `No recoverable lost quotes with an upcoming event in the next ${windowDays} days.` });
    setSessionResult(sid, { windowDays, candidates: 0, top: [] });
    return session;
  }

  appendEvent(sid, {
    kind: "recommendation",
    label: `Found ${top.length} lost quote${top.length === 1 ? "" : "s"} worth contacting now. Top: ${top[0].clientName} — ${top[0].eventName} (${money(top[0].value)}, in ${top[0].daysToEvent}d).`,
    payload: { top: top.map((t) => ({ id: t.id, client: t.clientName, value: t.value, daysToEvent: t.daysToEvent })) },
  });
  setSessionResult(sid, { windowDays, candidates: scored.length, top });

  // 4) Action — only auto-raise a proposal when the blade opted in; otherwise offer it for the human to
  //    trigger. Either way the action is a SAFE, human-decided note (no money, no send gate).
  const cfg = getBladeAiConfig("salesos");
  if (cfg.autoPropose) {
    const t = top[0];
    proposeFromSession(
      sid,
      {
        agentId: "lost-quote",
        owner: owner ?? "",
        title: `Log recovery flag: ${t.clientName}`,
        actionType: "append_note",
        actionPayload: { transactionId: t.id, line: `AI flagged this lost quote for recovery outreach (event in ${t.daysToEvent} days, ${money(t.value)}).` },
        card: {
          what: `Add a note to ${t.clientName}'s project flagging it for recovery outreach.`,
          why: `It is the highest-scoring recoverable lost quote (event in ${t.daysToEvent} days, ${money(t.value)}).`,
          dataUsed: `getLostQuotes() over the full booking history; scored on proximity + value.`,
          expectedOutcome: "A note in Goodshuffle so the rep knows AI surfaced this for recovery.",
          risk: "Low — a note only, no customer message is sent.",
          whatIfApproved: "A note_append op is queued to the Goodshuffle outbox.",
        },
        financial: false,
        idempotencyKey: `salesos:lostquote:note:${t.id}:${today}`,
      },
      opts.actor,
    );
  } else {
    appendEvent(sid, {
      kind: "action_available",
      label: `Draft recovery outreach for the top ${top.length}. Turn on auto-propose for Sales OS (AI Configuration) to let this raise drafts for approval.`,
    });
  }

  return session;
}
