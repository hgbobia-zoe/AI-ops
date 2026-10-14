import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseTriageResult,
  buildTriageSystem,
  triageViktorMessage,
  handleViktorFastPath,
  ROUTE_ACK,
  ROUTE_ACK_DEGRADED,
} from "./viktorFastPath";
import { chat, llmConfigured } from "@/lib/llm";
import { slackBotConfigured, slackPostMessage } from "@/lib/notify/slack";
import { responderHealthNow } from "@/lib/ai/responderHealth";
import { createSession, addInstruction, appendEvent, listSessionEvents, getSession, NEUTRAL_EVENT_KINDS } from "@/lib/ai/sessions";

vi.mock("@/lib/llm", () => ({ chat: vi.fn(), llmConfigured: vi.fn() }));
vi.mock("@/lib/notify/slack", () => ({ slackBotConfigured: vi.fn(), slackPostMessage: vi.fn() }));
vi.mock("@/lib/ai/responderHealth", () => ({ responderHealthNow: vi.fn() }));

const mockChat = vi.mocked(chat);
const mockConfigured = vi.mocked(llmConfigured);
const mockBot = vi.mocked(slackBotConfigured);
const mockPost = vi.mocked(slackPostMessage);
const mockHealth = vi.mocked(responderHealthNow);

beforeEach(() => {
  vi.clearAllMocks();
  mockConfigured.mockReturnValue(true);
  mockBot.mockReturnValue(true);
  mockPost.mockResolvedValue({ ok: true });
  mockHealth.mockReturnValue({ state: "alive", alive: true, ageMs: 1000, lastHeartbeatAt: new Date().toISOString() });
});

/** The newest event that actually counts (a session is "pending" when this is an instruction). */
function latestNonNeutral(sessionId: string) {
  return listSessionEvents(sessionId, 10).find((e) => !NEUTRAL_EVENT_KINDS.includes(e.kind));
}

function slackSession() {
  const s = createSession({
    agentId: "viktor",
    owner: "U1",
    title: "Slack: test",
    provider: "session-bridge",
    input: { source: "slack", slack: { channel: "C1", threadTs: "100.1", user: "U1" } },
  });
  addInstruction(s.id, "the question", "U1");
  return s;
}

describe("parseTriageResult", () => {
  it("parses a clean answer object", () => {
    expect(parseTriageResult('{"mode":"answer","answer":"Hi there"}')).toEqual({ mode: "answer", answer: "Hi there" });
  });
  it("parses a route object", () => {
    expect(parseTriageResult('{"mode":"route","answer":null}')).toEqual({ mode: "route", answer: null });
  });
  it("tolerates code fences and surrounding prose", () => {
    const raw = 'Sure:\n```json\n{"mode":"answer","answer":"ok"}\n```\nthanks';
    expect(parseTriageResult(raw)).toEqual({ mode: "answer", answer: "ok" });
  });
  it("treats an answer with empty text as a route (fail safe)", () => {
    expect(parseTriageResult('{"mode":"answer","answer":"   "}')).toEqual({ mode: "route", answer: null });
  });
  it("routes on malformed JSON", () => {
    expect(parseTriageResult("{not json")).toEqual({ mode: "route", answer: null });
  });
  it("routes on missing/unknown mode", () => {
    expect(parseTriageResult('{"foo":"bar"}')).toEqual({ mode: "route", answer: null });
    expect(parseTriageResult('{"mode":"other","answer":"x"}')).toEqual({ mode: "route", answer: null });
  });
  it("routes on empty / nullish input", () => {
    expect(parseTriageResult("")).toEqual({ mode: "route", answer: null });
    expect(parseTriageResult(null)).toEqual({ mode: "route", answer: null });
    expect(parseTriageResult(undefined)).toEqual({ mode: "route", answer: null });
  });
});

describe("buildTriageSystem", () => {
  it("names Viktor, the strict JSON contract, and the route-when-in-doubt rule", () => {
    const s = buildTriageSystem();
    expect(s).toContain("Viktor");
    expect(s).toContain('"mode"');
    expect(s.toLowerCase()).toContain("doubt");
  });
});

describe("triageViktorMessage", () => {
  it("routes without calling the model when the LLM is unconfigured", async () => {
    mockConfigured.mockReturnValue(false);
    expect(await triageViktorMessage("what can you do?")).toEqual({ mode: "route", answer: null });
    expect(mockChat).not.toHaveBeenCalled();
  });
  it("routes without a model call on empty text", async () => {
    expect(await triageViktorMessage("   ")).toEqual({ mode: "route", answer: null });
    expect(mockChat).not.toHaveBeenCalled();
  });
  it("returns the model's answer", async () => {
    mockChat.mockResolvedValue({ ok: true, text: '{"mode":"answer","answer":"I can help"}' });
    expect(await triageViktorMessage("what can you do?")).toEqual({ mode: "answer", answer: "I can help" });
  });
  it("routes when the model says route", async () => {
    mockChat.mockResolvedValue({ ok: true, text: '{"mode":"route","answer":null}' });
    expect(await triageViktorMessage("who is short staffed friday?")).toEqual({ mode: "route", answer: null });
  });
  it("routes (fail safe) when the model call fails", async () => {
    mockChat.mockResolvedValue({ ok: false, error: "boom" });
    expect(await triageViktorMessage("anything")).toEqual({ mode: "route", answer: null });
  });
});

describe("handleViktorFastPath", () => {
  it("skips (leaves pending) when no Slack bot token is set", async () => {
    mockBot.mockReturnValue(false);
    const s = slackSession();
    const out = await handleViktorFastPath({ sessionId: s.id, text: "hi", channel: "C1", threadTs: "100.1" });
    expect(out).toBe("skipped");
    expect(mockPost).not.toHaveBeenCalled();
    expect(latestNonNeutral(s.id)?.kind).toBe("instruction"); // still pending
  });

  it("answers a basic question: posts to the thread, records it, clears pending", async () => {
    mockChat.mockResolvedValue({ ok: true, text: '{"mode":"answer","answer":"I answer questions and tee up actions."}' });
    const s = slackSession();
    const out = await handleViktorFastPath({ sessionId: s.id, text: "what can you do?", channel: "C1", threadTs: "100.1" });
    expect(out).toBe("answered");
    expect(mockPost).toHaveBeenCalledWith("C1", expect.stringContaining("I answer questions"), "100.1");
    expect(latestNonNeutral(s.id)?.kind).toBe("message"); // no longer pending
    expect(getSession(s.id)?.result).toMatchObject({ type: "question", via: "fast-path" });
  });

  it("humanizes the answer (strips a dash) before posting", async () => {
    mockChat.mockResolvedValue({ ok: true, text: '{"mode":"answer","answer":"Sure thing - here is how it works."}' });
    const s = slackSession();
    await handleViktorFastPath({ sessionId: s.id, text: "how does it work?", channel: "C1", threadTs: "100.1" });
    const posted = mockPost.mock.calls[0][1];
    expect(posted).not.toMatch(/\s-\s/);
  });

  it("routes a real task: posts the ack, leaves the instruction pending for Tier 2", async () => {
    mockChat.mockResolvedValue({ ok: true, text: '{"mode":"route","answer":null}' });
    const s = slackSession();
    const out = await handleViktorFastPath({ sessionId: s.id, text: "text the friday crew", channel: "C1", threadTs: "100.1" });
    expect(out).toBe("routed");
    expect(mockPost).toHaveBeenCalledWith("C1", ROUTE_ACK, "100.1");
    expect(latestNonNeutral(s.id)?.kind).toBe("instruction"); // still pending for the responder
  });

  it("routes with an HONEST ack when the responder is down (no false 'in a moment' promise)", async () => {
    mockChat.mockResolvedValue({ ok: true, text: '{"mode":"route","answer":null}' });
    mockHealth.mockReturnValue({ state: "never", alive: false, ageMs: null, lastHeartbeatAt: null });
    const s = slackSession();
    const out = await handleViktorFastPath({ sessionId: s.id, text: "text the friday crew", channel: "C1", threadTs: "100.1" });
    expect(out).toBe("routed");
    expect(mockPost).toHaveBeenCalledWith("C1", ROUTE_ACK_DEGRADED, "100.1");
    expect(latestNonNeutral(s.id)?.kind).toBe("instruction"); // still pending for when it recovers
  });

  it("does not record the answer if the Slack post fails (stays pending for Tier 2)", async () => {
    mockChat.mockResolvedValue({ ok: true, text: '{"mode":"answer","answer":"hi"}' });
    mockPost.mockResolvedValue({ ok: false, error: "slack 500" });
    const s = slackSession();
    const out = await handleViktorFastPath({ sessionId: s.id, text: "what can you do?", channel: "C1", threadTs: "100.1" });
    expect(out).toBe("skipped");
    expect(latestNonNeutral(s.id)?.kind).toBe("instruction");
  });

  it("does not double-answer when the instruction was already responded to", async () => {
    mockChat.mockResolvedValue({ ok: true, text: '{"mode":"answer","answer":"hi again"}' });
    const s = slackSession();
    appendEvent(s.id, { kind: "message", actor: "AI responder", label: "already answered by Tier 2" });
    const out = await handleViktorFastPath({ sessionId: s.id, text: "what can you do?", channel: "C1", threadTs: "100.1" });
    expect(out).toBe("skipped");
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("skips a session that does not exist", async () => {
    const out = await handleViktorFastPath({ sessionId: "AS-nope", text: "hi", channel: "C1", threadTs: null });
    expect(out).toBe("skipped");
  });
});
