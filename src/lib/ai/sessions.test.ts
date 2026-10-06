import { describe, expect, it } from "vitest";
import {
  isSessionLive,
  isSessionTerminal,
  endStatusFor,
  createSession,
  getSession,
  endSession,
  appendEvent,
  listSessionEvents,
  recordToolRun,
  listSessionTools,
  linkSessionApproval,
  listSessionApprovalIds,
  listLiveSessions,
  countLiveSessionsByBlade,
  markAwaitingApproval,
} from "./sessions";

// Pure helpers — no DB.
describe("session status helpers", () => {
  it("classifies live vs terminal", () => {
    expect(isSessionLive("running")).toBe(true);
    expect(isSessionLive("awaiting_approval")).toBe(true);
    expect(isSessionLive("done")).toBe(false);
    expect(isSessionTerminal("failed")).toBe(true);
    expect(isSessionTerminal("cancelled")).toBe(true);
    expect(isSessionTerminal("running")).toBe(false);
  });

  it("only transitions a live session to a terminal outcome", () => {
    expect(endStatusFor("running", "done")).toBe("done");
    expect(endStatusFor("awaiting_approval", "cancelled")).toBe("cancelled");
    expect(endStatusFor("done", "failed")).toBeNull(); // already terminal — no-op
    expect(endStatusFor("failed", "done")).toBeNull();
  });
});

// Store — runs against the in-memory DB (DATABASE_PATH=:memory: from vitest.config.ts).
describe("session store", () => {
  it("opens a session, logs a started event, and is idempotent on the key", () => {
    const a = createSession({ agentId: "quote-analyst", blade: "salesos", owner: "Jessie", startedBy: "Hermann", title: "Review quote", idempotencyKey: "k-1" });
    expect(a.id).toMatch(/^AS-/);
    expect(a.status).toBe("running");
    const again = createSession({ agentId: "quote-analyst", blade: "salesos", title: "Review quote", idempotencyKey: "k-1" });
    expect(again.id).toBe(a.id); // same row, not a duplicate

    const events = listSessionEvents(a.id);
    expect(events.some((e) => e.kind === "started")).toBe(true);
  });

  it("appends events and keeps them newest-first", () => {
    const s = createSession({ agentId: "outreach", title: "Draft follow-up" });
    appendEvent(s.id, { kind: "step", label: "read lead" });
    appendEvent(s.id, { kind: "message", label: "drafted" });
    const events = listSessionEvents(s.id);
    // started + 2 appended
    expect(events.length).toBe(3);
    expect(events[0].kind).toBe("message"); // newest first
  });

  it("dedupes an event by change_key", () => {
    const s = createSession({ agentId: "outreach", title: "Dedupe" });
    const first = appendEvent(s.id, { kind: "step", label: "once", changeKey: "ck-1" });
    const dup = appendEvent(s.id, { kind: "step", label: "once", changeKey: "ck-1" });
    expect(first).not.toBeNull();
    expect(dup).toBeNull();
  });

  it("records tool runs oldest-first and logs a tool_call event", () => {
    const s = createSession({ agentId: "lead-intelligence", title: "Score leads" });
    recordToolRun(s.id, { toolId: "read_leads", category: "DATA", perm: "READ", status: "ok" });
    recordToolRun(s.id, { toolId: "score", category: "ANALYSIS", perm: "ANALYZE", status: "ok" });
    const tools = listSessionTools(s.id);
    expect(tools.map((t) => t.toolId)).toEqual(["read_leads", "score"]);
    expect(listSessionEvents(s.id).some((e) => e.kind === "tool_call")).toBe(true);
  });

  it("ends a session once (idempotent) and stores the result", () => {
    const s = createSession({ agentId: "quote-analyst", title: "Done once" });
    const ended = endSession(s.id, "done", { result: { recommendation: "keep" }, actor: "Hermann" });
    expect(ended?.status).toBe("done");
    expect(ended?.result).toEqual({ recommendation: "keep" });
    expect(ended?.endedAt).toBeTruthy();
    // ending again is a no-op and does not overwrite
    const reended = endSession(s.id, "failed", { error: "nope" });
    expect(reended?.status).toBe("done");
    expect(reended?.error).toBeNull();
  });

  it("links an approval, flips to awaiting_approval, and is idempotent", () => {
    const s = createSession({ agentId: "outreach", blade: "salesos", title: "Propose SMS" });
    linkSessionApproval(s.id, "AP-xyz", "Hermann");
    linkSessionApproval(s.id, "AP-xyz", "Hermann"); // duplicate link — no-op
    expect(listSessionApprovalIds(s.id)).toEqual(["AP-xyz"]);
    expect(getSession(s.id)?.status).toBe("awaiting_approval");
    expect(listSessionEvents(s.id).some((e) => e.kind === "approval_raised")).toBe(true);
  });

  it("markAwaitingApproval does not resurrect a terminal session", () => {
    const s = createSession({ agentId: "outreach", title: "Terminal" });
    endSession(s.id, "cancelled", {});
    const after = markAwaitingApproval(s.id);
    expect(after?.status).toBe("cancelled");
  });

  it("counts live sessions and lists them", () => {
    const before = listLiveSessions().length;
    const s = createSession({ agentId: "dispatch-route", blade: "dispatch", title: "Live one" });
    expect(listLiveSessions().length).toBe(before + 1);
    expect(countLiveSessionsByBlade().dispatch).toBeGreaterThanOrEqual(1);
    endSession(s.id, "done", {});
    expect(listLiveSessions().length).toBe(before);
  });
});
