import { describe, expect, it, vi, beforeEach } from "vitest";

// Slack is never configured in tests, but the failure path alerts ops; capture instead of sending.
const notified: string[] = [];
vi.mock("@/lib/notify/slack", async (orig) => {
  const real = await orig<typeof import("@/lib/notify/slack")>();
  return {
    ...real,
    slackBotConfigured: () => false,
    slackPostMessage: vi.fn(async () => ({ ok: true })),
    slackNotify: vi.fn(async (t: string) => {
      notified.push(t);
      return { ok: true };
    }),
  };
});

vi.mock("@/lib/notify/status", async (orig) => {
  const real = await orig<typeof import("@/lib/notify/status")>();
  return {
    ...real,
    postStatus: vi.fn(async (a: import("@/lib/notify/status").StatusAlert) => {
      notified.push(real.statusText(a));
      return { ok: true };
    }),
  };
});

import type Anthropic from "@anthropic-ai/sdk";
import { createSession, addInstruction, listSessionEvents, listSessionApprovalIds, getSession, appendEvent } from "@/lib/ai/sessions";
import { getApproval } from "@/lib/aiorg/approvals";
import { listRequests } from "@/lib/ai/requests";
import { saveBookings, insertCallEventIfNew, saveCoachingAnalysis } from "@/lib/db/repo";
import { historyToMessages, buildUserTurn, runViktorAgent, type ViktorClient } from "./agent";
import { redactMoney, parseCard, VIKTOR_TOOLS } from "./tools";
import { deriveViktorHealth, handleSessionInstruction, pendingInstructionOf, viktorHealthNow, STALE_CLAIM_MS, WORKING_LABEL } from "./worker";

type Msg = Anthropic.Beta.BetaMessage;

function reply(content: Msg["content"], stop: Msg["stop_reason"]): Msg {
  return { id: "msg_x", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason: stop, stop_sequence: null, usage: {} } as unknown as Msg;
}
function text(t: string): Msg {
  return reply([{ type: "text", text: t, citations: null } as unknown as Msg["content"][number]], "end_turn");
}
function toolCall(name: string, input: Record<string, unknown>, id = "tu_1"): Msg {
  return reply([{ type: "tool_use", id, name, input } as unknown as Msg["content"][number]], "tool_use");
}
/** A fake client that returns the scripted replies in order and records each request. */
function scripted(...replies: Msg[]): ViktorClient & { calls: Anthropic.Beta.MessageCreateParamsNonStreaming[] } {
  const calls: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
  return {
    calls,
    create: async (p) => {
      calls.push(JSON.parse(JSON.stringify(p)));
      const next = replies.shift();
      if (!next) throw new Error("no more scripted replies");
      return next;
    },
  };
}

const CARD = { what: "Email the client", why: "They asked", dataUsed: "booking 123", expectedOutcome: "Client informed", risk: "Low", whatIfApproved: "Email is queued" };

function newSession(key: string, agentId = "viktor") {
  return createSession({ agentId, owner: "Hermann", startedBy: "test", title: `T ${key}`, provider: "viktor-agent", input: {}, idempotencyKey: key });
}

describe("pure helpers", () => {
  it("historyToMessages merges same-role turns, starts on user, ends on assistant", () => {
    const msgs = historyToMessages([
      { at: 1, speaker: "viktor", text: "earlier alert", source: "slack" },
      { at: 2, speaker: "user", text: "a", source: "slack" },
      { at: 3, speaker: "user", text: "b", source: "slack" },
      { at: 4, speaker: "viktor", text: "c", source: "db" },
      { at: 5, speaker: "user", text: "d", source: "db" },
    ]);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(msgs[0].content).toBe("a\n\nb");
  });

  it("buildUserTurn tells the model whether money may be shown", () => {
    const base = { instruction: "how is today", surface: "slack" as const, today: "2026-11-03" };
    const ctx = { sessionId: "s", instructionTs: "t", askedBy: "u", instruction: "x", blade: null };
    expect(buildUserTurn({ ...base, ctx: { ...ctx, showMoney: false } })).toContain("NOT cleared");
    expect(buildUserTurn({ ...base, ctx: { ...ctx, showMoney: true } })).toContain("may see financial");
  });

  it("redactMoney strips money keys recursively unless allowed", () => {
    const v = { a: 1, grandTotal: 500, nested: [{ amountDue: 3, name: "x" }] };
    expect(redactMoney(v, false)).toEqual({ a: 1, nested: [{ name: "x" }] });
    expect(redactMoney(v, true)).toEqual(v);
  });

  it("parseCard needs all six fields", () => {
    expect(parseCard(CARD)).toEqual(CARD);
    expect(parseCard({ ...CARD, risk: " " })).toBeNull();
    expect(parseCard(null)).toBeNull();
  });

  it("tool list is stable and every schema closes additional properties", () => {
    expect(VIKTOR_TOOLS.map((t) => t.name)).toContain("propose_action");
    expect(VIKTOR_TOOLS.map((t) => t.name)).toContain("act_on_call");
    for (const t of VIKTOR_TOOLS) expect((t.input_schema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
  });

  it("deriveViktorHealth reflects config and recent failures", () => {
    const rec = { lastRunAt: null, lastOk: null, lastError: null, lastOkAt: null, consecutiveFailures: 0, model: null };
    expect(deriveViktorHealth(rec, { enabled: false, configured: true }).state).toBe("disabled");
    expect(deriveViktorHealth(rec, { enabled: true, configured: false }).state).toBe("not_configured");
    expect(deriveViktorHealth(rec, { enabled: true, configured: true }).state).toBe("ready");
    expect(deriveViktorHealth({ ...rec, lastOk: false, consecutiveFailures: 2, lastError: "401" }, { enabled: true, configured: true }).state).toBe("degraded");
  });
});

describe("runViktorAgent", () => {
  it("runs a governed write through propose_action, then answers", async () => {
    const s = newSession("agent-propose");
    const client = scripted(toolCall("propose_action", { title: "Email Smith about delivery", actionType: "send_email", card: CARD, actionPayload: { transactionId: "123" } }), text("Raised an approval for that."));
    const r = await runViktorAgent(
      { instruction: "email smith", history: [], surface: "app", today: "2026-11-03", ctx: { sessionId: s.id, instructionTs: "ts-1", askedBy: "Hermann", instruction: "email smith", showMoney: false, blade: null } },
      client,
    );
    expect(r.ok).toBe(true);
    expect(r.text).toBe("Raised an approval for that.");
    expect(r.writes).toHaveLength(1);
    const ids = listSessionApprovalIds(s.id);
    expect(ids).toHaveLength(1);
    expect(getApproval(ids[0])?.status).toBe("pending");
    // Second request carries the tool result back in a single user turn.
    const second = client.calls[1];
    const last = second.messages[second.messages.length - 1];
    expect(last.role).toBe("user");
    expect(Array.isArray(last.content) && (last.content[0] as { type: string }).type).toBe("tool_result");
    // Caching + fallback are on every request.
    expect(client.calls[0].cache_control).toEqual({ type: "ephemeral" });
    expect(client.calls[0].fallbacks).toBe("default");
  });

  it("acts on a finished call: raises linked approval cards once, and a re-run duplicates nothing", async () => {
    saveBookings([
      { bookingId: "GS-777", eventName: "Smith Wedding", eventDate: "2027-06-12", statusLabel: "Quote Sent", signed: false, grandTotal: 4200, clientName: "Dana Smith", clientEmail: "dana@example.com", clientPhone: "(301) 555-0199" },
    ]);
    const callId = insertCallEventIfNew({
      providerId: "op-act-1",
      direction: "inbound",
      fromPhone: "+13015550199",
      toPhone: "+13012915296",
      contactName: "Dana Smith",
      durationSec: 300,
      transcript: "Dana: we need three generators for the wedding. Rep: I will send delivery windows today.",
      occurredAt: "2026-11-10T15:00:00.000Z",
    })!;
    saveCoachingAnalysis(callId, {
      executive: "Dana wants three generators for the June wedding.",
      keyPoints: ["three generators"],
      actionItems: ["Send delivery window options"],
      customerConcerns: [],
      objections: [],
      followUpEmail: "Subject: Your generators\n\nHi Dana,\n\nI will send the delivery windows today.\n\nBest,\nZoe",
      coachingNotes: [],
      nextStep: "Send delivery windows",
      model: "test",
    } as unknown as Parameters<typeof saveCoachingAnalysis>[1]);

    const run = async (key: string) => {
      const s = newSession(key);
      const r = await runViktorAgent(
        {
          instruction: "act on my last call with Dana",
          history: [],
          surface: "slack",
          today: "2026-11-10",
          ctx: { sessionId: s.id, instructionTs: key, askedBy: "U0123ABCD", instruction: "act on my last call with Dana", showMoney: false, blade: null },
        },
        scripted(toolCall("act_on_call", { contact: "Dana" }), text("Done.")),
      );
      return { s, r };
    };

    const first = await run("act-call-1");
    expect(first.r.ok).toBe(true);
    // email + note + 1 task + held text; no quote card because pricing never came up.
    expect(first.r.writes.map((w) => w.title)).toEqual([
      "Follow-up email to Dana Smith",
      "Log a call note on Dana Smith's project",
      "Task: Send delivery window options",
      "Follow-up text to Dana Smith",
    ]);
    const ids = listSessionApprovalIds(first.s.id);
    expect(ids).toHaveLength(4);
    const email = ids.map((id) => getApproval(id)!).find((a) => a.actionType === "send_email")!;
    expect(email.status).toBe("pending");
    expect(email.agentId).toBe("sales-coach");
    expect(email.owner).toBe("Jessie");
    expect(email.actionPayload).toMatchObject({ transactionId: "GS-777", subject: "Your generators" });

    // Asking again finds the same cards: no new writes, nothing duplicated.
    const second = await run("act-call-2");
    expect(second.r.ok).toBe(true);
    expect(second.r.writes).toHaveLength(0);
  });

  it("returns an error (not a throw) when the tool loop never finishes", async () => {
    const s = newSession("agent-loop");
    const loops = Array.from({ length: 10 }, (_, i) => toolCall("pending_approvals", {}, `tu_${i}`));
    const r = await runViktorAgent(
      { instruction: "x", history: [], surface: "app", today: "2026-11-03", ctx: { sessionId: s.id, instructionTs: "ts", askedBy: "u", instruction: "x", showMoney: false, blade: null } },
      scripted(...loops),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/stopped after/);
  });

  it("reports a refusal honestly", async () => {
    const s = newSession("agent-refusal");
    const r = await runViktorAgent(
      { instruction: "x", history: [], surface: "app", today: "2026-11-03", ctx: { sessionId: s.id, instructionTs: "ts", askedBy: "u", instruction: "x", showMoney: false, blade: null } },
      scripted(reply([], "refusal")),
    );
    expect(r).toMatchObject({ ok: false, error: "the model declined this request" });
  });
});

describe("handleSessionInstruction", () => {
  beforeEach(() => {
    notified.length = 0;
  });

  it("answers once, records the reply, and a second trigger is a no-op", async () => {
    const s = newSession("worker-answer");
    addInstruction(s.id, "what is pending?", "Hermann");
    const client = scripted(text("Nothing is pending right now."));
    expect(await handleSessionInstruction(s.id, { client, ackAfterMs: 0 })).toBe("answered");
    expect(await handleSessionInstruction(s.id, { client, ackAfterMs: 0 })).toBe("skipped");
    const reply = listSessionEvents(s.id).find((e) => e.kind === "message");
    expect(reply?.label).toBe("Nothing is pending right now.");
    expect(getSession(s.id)?.result).toMatchObject({ via: "viktor-agent" });
    expect(pendingInstructionOf(s.id)).toBeNull();
    expect(viktorHealthNow().lastOk).toBe(true);
  });

  it("files a feature request", async () => {
    const s = newSession("worker-feature");
    addInstruction(s.id, "the dispatch board should show weather", "Lisa");
    await handleSessionInstruction(s.id, {
      client: scripted(toolCall("file_feature_request", { title: "Weather on dispatch board", body: "the dispatch board should show weather", blade: "dispatch" }), text("Filed it under Requests.")),
      ackAfterMs: 0,
    });
    expect(listRequests({ type: "feature" }).some((r) => r.title === "Weather on dispatch board" && r.sessionId === s.id)).toBe(true);
  });

  it("records a failure on the timeline, alerts ops, and marks health degraded", async () => {
    const s = newSession("worker-fail");
    addInstruction(s.id, "hello", "Hermann");
    const client: ViktorClient = {
      create: async () => {
        throw new Error("boom");
      },
    };
    expect(await handleSessionInstruction(s.id, { client, ackAfterMs: 0 })).toBe("failed");
    expect(listSessionEvents(s.id).some((e) => e.kind === "error" && /boom/.test(e.label ?? ""))).toBe(true);
    expect(notified.some((t) => /could not answer/.test(t) && /boom/.test(t))).toBe(true);
    expect(viktorHealthNow().state === "degraded" || viktorHealthNow().state === "not_configured").toBe(true);
  });

  it("does nothing when switched off except saying so once", async () => {
    const s = newSession("worker-off");
    addInstruction(s.id, "hello", "Hermann");
    process.env.VIKTOR_AGENT = "false";
    try {
      expect(await handleSessionInstruction(s.id, { client: scripted(), ackAfterMs: 0 })).toBe("disabled");
      expect(await handleSessionInstruction(s.id, { client: scripted(), ackAfterMs: 0 })).toBe("skipped");
    } finally {
      delete process.env.VIKTOR_AGENT;
    }
  });

  it("re-picks an instruction whose claim went stale (restart mid-run)", () => {
    const s = newSession("worker-stale");
    addInstruction(s.id, "hello", "Hermann");
    appendEvent(s.id, { kind: "step", actor: "Viktor", label: WORKING_LABEL });
    expect(pendingInstructionOf(s.id)).toBeNull();
    const later = Date.now() + STALE_CLAIM_MS + 1000;
    expect(pendingInstructionOf(s.id, later)).toMatchObject({ text: "hello", reclaim: true });
  });
});
