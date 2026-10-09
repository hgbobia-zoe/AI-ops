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
  listRecentSessions,
  listArchivedSessions,
  countLiveSessionsByBlade,
  markAwaitingApproval,
  pauseSession,
  resumeSession,
  renameSession,
  setObjective,
  archiveSession,
  addInstruction,
  listRecentSessionCards,
  countCompletedToday,
  sessionIdForApproval,
  listPendingInstructions,
  countPendingInstructions,
  claimInstruction,
} from "./sessions";

// Pure helpers — no DB.
describe("session status helpers", () => {
  it("classifies live vs terminal", () => {
    expect(isSessionLive("running")).toBe(true);
    expect(isSessionLive("awaiting_approval")).toBe(true);
    expect(isSessionLive("paused")).toBe(true);
    expect(isSessionLive("done")).toBe(false);
    expect(isSessionTerminal("failed")).toBe(true);
    expect(isSessionTerminal("cancelled")).toBe(true);
    expect(isSessionTerminal("paused")).toBe(false);
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

  it("stores an objective at creation and lets it be changed", () => {
    const s = createSession({ agentId: "lead-intelligence", blade: "salesos", title: "Obj", objective: "Recover lost quotes" });
    expect(s.objective).toBe("Recover lost quotes");
    const after = setObjective(s.id, "Recover quotes within 14 days", "Hermann");
    expect(after?.objective).toBe("Recover quotes within 14 days");
    expect(listSessionEvents(s.id).some((e) => e.kind === "instruction")).toBe(true);
  });

  it("pauses, resumes, and renames; paused counts as live but not terminal", () => {
    const s = createSession({ agentId: "outreach", blade: "salesos", title: "Lifecycle" });
    expect(pauseSession(s.id)?.status).toBe("paused");
    expect(listLiveSessions().some((x) => x.id === s.id)).toBe(true); // paused is still live/resumable
    expect(resumeSession(s.id)?.status).toBe("running");
    expect(renameSession(s.id, "Renamed session")?.title).toBe("Renamed session");
  });

  it("archives a session out of the live/recent feeds and back", () => {
    const s = createSession({ agentId: "outreach", title: "Archive me" });
    archiveSession(s.id, true, "Hermann");
    expect(getSession(s.id)?.archived).toBe(true);
    expect(listRecentSessions().some((x) => x.id === s.id)).toBe(false);
    expect(listLiveSessions().some((x) => x.id === s.id)).toBe(false);
    expect(listArchivedSessions().some((x) => x.id === s.id)).toBe(true);
    archiveSession(s.id, false);
    expect(getSession(s.id)?.archived).toBe(false);
    expect(listRecentSessions().some((x) => x.id === s.id)).toBe(true);
  });

  it("lists session cards with the latest activity line", () => {
    const s = createSession({ agentId: "lost-quote", blade: "salesos", title: "Card test" });
    appendEvent(s.id, { kind: "step", label: "Retrieved 34 lost quotes" });
    appendEvent(s.id, { kind: "recommendation", label: "6 to contact today" });
    const card = listRecentSessionCards(50).find((c) => c.id === s.id);
    expect(card).toBeTruthy();
    expect(card!.lastActivity).toBe("6 to contact today"); // newest labelled event
  });

  it("counts sessions completed today and links an approval back to its session", () => {
    const today = new Date().toISOString().slice(0, 10);
    const before = countCompletedToday(today); // other tests share the in-memory DB
    const s = createSession({ agentId: "outreach", title: "Done today" });
    endSession(s.id, "done", {});
    expect(countCompletedToday(today)).toBe(before + 1);
    expect(countCompletedToday("1999-01-01")).toBe(0);

    const s2 = createSession({ agentId: "outreach", title: "Has approval" });
    linkSessionApproval(s2.id, "AP-link-1");
    expect(sessionIdForApproval("AP-link-1")).toBe(s2.id);
    expect(sessionIdForApproval("AP-nope")).toBeNull();
  });

  it("adds an instruction and resumes a paused session; refuses on a closed one", () => {
    const s = createSession({ agentId: "outreach", title: "Instruct" });
    pauseSession(s.id);
    const after = addInstruction(s.id, "Focus on events within 14 days", "Hermann");
    expect(after?.status).toBe("running");
    expect(listSessionEvents(s.id).some((e) => e.kind === "instruction")).toBe(true);

    const closed = createSession({ agentId: "outreach", title: "Closed" });
    endSession(closed.id, "done", {});
    const refused = addInstruction(closed.id, "do more", "Hermann");
    expect(refused?.status).toBe("done"); // unchanged
    expect(listSessionEvents(closed.id).some((e) => e.kind === "error")).toBe(true);
  });
});

// Pending-instruction drain queue (the bridge responder feed).
describe("pending instructions", () => {
  const ids = (ps: { sessionId: string }[]) => ps.map((p) => p.sessionId);

  it("surfaces a session whose newest non-neutral event is an unanswered instruction", () => {
    const s = createSession({ agentId: "scheduling-assistant", blade: "scheduling", owner: "Lisa", title: "Q", objective: "Keep crews staffed" });
    addInstruction(s.id, "Capture route changes after schedules are done", "Hermann");
    const pending = listPendingInstructions(100);
    const mine = pending.find((p) => p.sessionId === s.id);
    expect(mine).toBeTruthy();
    expect(mine!.instruction).toBe("Capture route changes after schedules are done");
    expect(mine!.askedBy).toBe("Hermann");
    expect(mine!.owner).toBe("Lisa");
    expect(mine!.blade).toBe("scheduling");
    expect(mine!.objective).toBe("Keep crews staffed");
  });

  it("a response-kind event clears pending; a neutral event does not", () => {
    const answered = createSession({ agentId: "outreach", title: "Answered" });
    addInstruction(answered.id, "draft a follow-up", "Hermann");
    appendEvent(answered.id, { kind: "message", label: "here is a draft" });
    expect(ids(listPendingInstructions(100))).not.toContain(answered.id);

    const neutral = createSession({ agentId: "outreach", title: "Neutral-after" });
    addInstruction(neutral.id, "look into this", "Hermann");
    pauseSession(neutral.id); // state_change — neutral, must NOT clear pending
    expect(ids(listPendingInstructions(100))).toContain(neutral.id);
  });

  it("excludes terminal and archived sessions even with a trailing instruction", () => {
    const term = createSession({ agentId: "outreach", title: "Terminal-pending" });
    addInstruction(term.id, "too late", "Hermann");
    endSession(term.id, "cancelled", {});
    expect(ids(listPendingInstructions(100))).not.toContain(term.id);

    const arch = createSession({ agentId: "outreach", title: "Archived-pending" });
    addInstruction(arch.id, "filed away", "Hermann");
    archiveSession(arch.id, true);
    expect(ids(listPendingInstructions(100))).not.toContain(arch.id);
  });

  it("claim records a step, drops the session from the queue, and is idempotent per instruction", () => {
    const s = createSession({ agentId: "dispatch-route", blade: "dispatch", title: "Claimable" });
    addInstruction(s.id, "what changed on route 3?", "Hermann");
    const p = listPendingInstructions(100).find((x) => x.sessionId === s.id)!;
    expect(p).toBeTruthy();

    const ev = claimInstruction(s.id, p.instructionTs);
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe("step");
    // No longer pending once claimed (the step is a response-kind event).
    expect(ids(listPendingInstructions(100))).not.toContain(s.id);
    // Retried claim for the same instruction is a no-op (dedup by changeKey).
    expect(claimInstruction(s.id, p.instructionTs)).toBeNull();
  });

  it("counts pending instructions consistently with the list", () => {
    expect(countPendingInstructions()).toBe(listPendingInstructions(1000).length);
  });
});
