import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  normText,
  dbEventsToTurns,
  slackMessagesToTurns,
  mergeTranscript,
  formatTranscript,
  assembleThreadContext,
  type TranscriptTurn,
} from "./threadContext";
import type { AiSessionEvent } from "./sessions";
import { createSession, addInstruction } from "./sessions";
import { slackConversationsReplies, slackBotConfigured, type SlackMessage } from "@/lib/notify/slack";

vi.mock("@/lib/notify/slack", () => ({ slackConversationsReplies: vi.fn(), slackBotConfigured: vi.fn() }));

const mockReplies = vi.mocked(slackConversationsReplies);
const mockBot = vi.mocked(slackBotConfigured);

beforeEach(() => {
  vi.clearAllMocks();
  mockBot.mockReturnValue(true);
});

function ev(kind: AiSessionEvent["kind"], label: string, ts: string): AiSessionEvent {
  return { id: `AE-${label}`, sessionId: "S", ts, actor: null, kind, label, payload: null };
}
function slackMsg(ts: string, text: string, opts: { botId?: string; username?: string; user?: string } = {}): SlackMessage {
  return { ts, text, botId: opts.botId ?? null, username: opts.username ?? null, user: opts.user ?? null };
}

describe("normText", () => {
  it("trims, collapses whitespace, lowercases", () => {
    expect(normText("  Hello   World  ")).toBe("hello world");
  });
});

describe("slackMessagesToTurns", () => {
  it("labels a bot/persona post as Viktor and a real user as the user", () => {
    const turns = slackMessagesToTurns([
      slackMsg("1700000000.0001", "who is working friday?", { user: "U1" }),
      slackMsg("1700000001.0001", "Marcus and Dana are on Friday.", { botId: "B1" }),
      slackMsg("1700000002.0001", "RED gate: Saturday route is unstaffed", { username: "Scheduling Bot", botId: "B1" }),
    ]);
    expect(turns.map((t) => t.speaker)).toEqual(["user", "viktor", "viktor"]);
    expect(turns[0].source).toBe("slack");
  });
  it("skips empty-text messages", () => {
    expect(slackMessagesToTurns([slackMsg("1700000000.0001", "   ")])).toEqual([]);
  });
});

describe("dbEventsToTurns", () => {
  it("maps instruction→user and message/recommendation→viktor, skipping neutral + empty", () => {
    const turns = dbEventsToTurns([
      ev("started", "Slack: hi", "2026-01-01T00:00:00.000Z"),
      ev("instruction", "who is working friday?", "2026-01-01T00:00:01.000Z"),
      ev("message", "Marcus and Dana.", "2026-01-01T00:00:02.000Z"),
      ev("state_change", "Paused", "2026-01-01T00:00:03.000Z"),
      ev("recommendation", "Consider adding a 4th.", "2026-01-01T00:00:04.000Z"),
      ev("instruction", "   ", "2026-01-01T00:00:05.000Z"),
    ]);
    expect(turns.map((t) => `${t.speaker}:${t.text}`)).toEqual([
      "user:who is working friday?",
      "viktor:Marcus and Dana.",
      "viktor:Consider adding a 4th.",
    ]);
  });
});

describe("mergeTranscript", () => {
  const slack: TranscriptTurn[] = [
    { at: 1000, speaker: "user", text: "who is working friday?", source: "slack" },
    { at: 2000, speaker: "viktor", text: "Marcus and Dana.", source: "slack" },
  ];
  it("drops a DB turn that duplicates a Slack turn (same speaker + text)", () => {
    const db: TranscriptTurn[] = [
      { at: 1000, speaker: "user", text: "Who is working Friday?", source: "db" }, // dup (case/space-insensitive)
      { at: 3000, speaker: "user", text: "and saturday?", source: "db" }, // unique
    ];
    const out = mergeTranscript(slack, db);
    expect(out.map((t) => t.text)).toEqual(["who is working friday?", "Marcus and Dana.", "and saturday?"]);
  });
  it("orders chronologically across both sources", () => {
    const db: TranscriptTurn[] = [{ at: 500, speaker: "user", text: "earlier", source: "db" }];
    const out = mergeTranscript(slack, db);
    expect(out[0].text).toBe("earlier");
  });
  it("excludes the just-arrived message by text", () => {
    const out = mergeTranscript(slack, [], { excludeText: "  Marcus and Dana.  " });
    expect(out.map((t) => t.text)).toEqual(["who is working friday?"]);
  });
  it("caps to the most recent maxTurns", () => {
    const many: TranscriptTurn[] = Array.from({ length: 30 }, (_, i) => ({ at: i, speaker: "user" as const, text: `m${i}`, source: "slack" as const }));
    const out = mergeTranscript(many, [], { maxTurns: 5 });
    expect(out.map((t) => t.text)).toEqual(["m25", "m26", "m27", "m28", "m29"]);
  });
  it("trims from the oldest end to honor the char budget", () => {
    const turns: TranscriptTurn[] = [
      { at: 1, speaker: "user", text: "AAAAA", source: "slack" },
      { at: 2, speaker: "user", text: "BBBBB", source: "slack" },
      { at: 3, speaker: "user", text: "CCCCC", source: "slack" },
    ];
    const out = mergeTranscript(turns, [], { maxChars: 10 });
    expect(out.map((t) => t.text)).toEqual(["BBBBB", "CCCCC"]);
  });
});

describe("formatTranscript", () => {
  it("labels speakers", () => {
    expect(
      formatTranscript([
        { at: 1, speaker: "user", text: "hi", source: "slack" },
        { at: 2, speaker: "viktor", text: "hello", source: "slack" },
      ]),
    ).toBe("User: hi\nViktor: hello");
  });
});

describe("assembleThreadContext — IO + honest degrade", () => {
  it("merges the Slack thread when the read succeeds (slackRead=ok)", async () => {
    const s = createSession({ agentId: "viktor", title: "Slack", input: { source: "slack" } });
    addInstruction(s.id, "who is working friday?", "U1");
    mockReplies.mockResolvedValue({
      ok: true,
      messages: [
        slackMsg("1700000000.0001", "who is working friday?", { user: "U1" }),
        slackMsg("1700000001.0001", "RED gate: Saturday unstaffed", { botId: "B1", username: "Scheduling Bot" }),
      ],
    });
    const ctx = await assembleThreadContext({ sessionId: s.id, slack: { channel: "C1", threadTs: "1700000000.0001" } });
    expect(ctx.slackRead).toBe("ok");
    // The Viktor alert post (not a session event) is present — this is the whole point.
    expect(ctx.formatted).toContain("Viktor: RED gate: Saturday unstaffed");
  });

  it("falls back to the in-DB transcript when the Slack read fails (slackRead=unavailable)", async () => {
    const s = createSession({ agentId: "viktor", title: "Slack", input: { source: "slack" } });
    addInstruction(s.id, "who is working friday?", "U1");
    mockReplies.mockResolvedValue({ ok: false, error: "missing_scope", messages: [] });
    const ctx = await assembleThreadContext({ sessionId: s.id, slack: { channel: "C1", threadTs: "1700000000.0001" } });
    expect(ctx.slackRead).toBe("unavailable");
    expect(ctx.formatted).toContain("User: who is working friday?"); // DB fallback still has the human turn
  });

  it("reports no_target and uses DB-only when there is no Slack thread", async () => {
    const s = createSession({ agentId: "viktor", title: "Session" });
    addInstruction(s.id, "do a thing", "U1");
    const ctx = await assembleThreadContext({ sessionId: s.id, slack: null });
    expect(ctx.slackRead).toBe("no_target");
    expect(mockReplies).not.toHaveBeenCalled();
  });

  it("never throws when the Slack read itself throws — degrades to DB", async () => {
    const s = createSession({ agentId: "viktor", title: "Slack", input: { source: "slack" } });
    addInstruction(s.id, "hello there", "U1");
    mockReplies.mockRejectedValue(new Error("boom"));
    const ctx = await assembleThreadContext({ sessionId: s.id, slack: { channel: "C1", threadTs: "t" } });
    expect(ctx.slackRead).toBe("unavailable");
    expect(ctx.formatted).toContain("User: hello there");
  });
});
