import { describe, it, expect } from "vitest";
import {
  deriveLifecycleFromStatus,
  legacyStatusFor,
  resolveAssignmentTransition,
  getAssignmentActions,
  isLiveAssignment,
  deriveShiftLifecycle,
  isTerminalShiftState,
  type ShiftLifecycleFacts,
} from "./lifecycle";

describe("legacy status <-> lifecycle mapping", () => {
  it("backfills a lifecycle state from the legacy status", () => {
    expect(deriveLifecycleFromStatus("draft")).toBe("DRAFT");
    expect(deriveLifecycleFromStatus("confirmed")).toBe("STAFFED");
    expect(deriveLifecycleFromStatus("sent")).toBe("PROVISIONED");
    expect(deriveLifecycleFromStatus("cancelled")).toBe("CANCELLED");
  });

  it("projects a lifecycle state back to the legacy status (everything sent-onward reads 'sent')", () => {
    expect(legacyStatusFor("DRAFT")).toBe("draft");
    expect(legacyStatusFor("EXCEPTION")).toBe("draft");
    expect(legacyStatusFor("STAFFED")).toBe("confirmed");
    expect(legacyStatusFor("PROVISIONED")).toBe("sent");
    expect(legacyStatusFor("NOTIFIED")).toBe("sent");
    expect(legacyStatusFor("READY")).toBe("sent");
    expect(legacyStatusFor("IN_PROGRESS")).toBe("sent");
    expect(legacyStatusFor("COMPLETE")).toBe("sent");
    expect(legacyStatusFor("CANCELLED")).toBe("cancelled");
  });
});

describe("assignment state machine", () => {
  it("accepts a legal transition and returns the resulting state", () => {
    expect(resolveAssignmentTransition("PROPOSED", "ASSIGN")).toBe("ASSIGNED");
    expect(resolveAssignmentTransition("ASSIGNED", "NOTIFY")).toBe("NOTIFIED");
    expect(resolveAssignmentTransition("NOTIFIED", "CONFIRM")).toBe("CONFIRMED");
    expect(resolveAssignmentTransition("CONFIRMED", "CLOCK_IN")).toBe("CLOCKED_IN");
    expect(resolveAssignmentTransition("CLOCKED_IN", "CLOCK_OUT")).toBe("CLOCKED_OUT");
  });

  it("rejects an illegal (from, action) pair", () => {
    expect(resolveAssignmentTransition("PROPOSED", "CLOCK_IN")).toBeNull();
    expect(resolveAssignmentTransition("CLOCKED_OUT", "CONFIRM")).toBeNull();
  });

  it("guards approval-only transitions (cancel/replace) behind isAdmin", () => {
    expect(resolveAssignmentTransition("CONFIRMED", "CANCEL")).toBeNull();
    expect(resolveAssignmentTransition("CONFIRMED", "CANCEL", { isAdmin: true })).toBe("CANCELLED");
    expect(resolveAssignmentTransition("NOTIFIED", "REPLACE")).toBeNull();
    expect(resolveAssignmentTransition("NOTIFIED", "REPLACE", { isAdmin: true })).toBe("REPLACED");
  });

  it("getAssignmentActions hides approval actions unless admin", () => {
    const basic = getAssignmentActions("CONFIRMED").map((a) => a.action);
    expect(basic).toContain("CLOCK_IN");
    expect(basic).not.toContain("CANCEL");
    const admin = getAssignmentActions("CONFIRMED", { isAdmin: true }).map((a) => a.action);
    expect(admin).toContain("CANCEL");
    expect(admin).toContain("REPLACE");
  });

  it("isLiveAssignment counts committed seats, not proposed/terminal/no-show", () => {
    expect(isLiveAssignment("ASSIGNED")).toBe(true);
    expect(isLiveAssignment("CONFIRMED")).toBe(true);
    expect(isLiveAssignment("CLOCKED_IN")).toBe(true);
    expect(isLiveAssignment("PROPOSED")).toBe(false);
    expect(isLiveAssignment("NO_SHOW")).toBe(false);
    expect(isLiveAssignment("DECLINED")).toBe(false);
    expect(isLiveAssignment("REPLACED")).toBe(false);
    expect(isLiveAssignment("CLOCKED_OUT")).toBe(false);
  });
});

describe("deriveShiftLifecycle (deterministic roll-up)", () => {
  const base: ShiftLifecycleFacts = {
    cancelled: false,
    gap: 0,
    windowKnown: true,
    published: false,
    gigPosted: false,
    assignmentCount: 1,
    allPacketsSent: false,
    allConfirmed: false,
    readinessReady: false,
    anyClockIn: false,
    blockingException: false,
    now: 1_000,
    startMs: 10_000,
    endMs: 20_000,
  };

  it("cancelled wins over everything", () => {
    expect(deriveShiftLifecycle({ ...base, cancelled: true, readinessReady: true })).toBe("CANCELLED");
  });

  it("an open gap or unknown window keeps it DRAFT", () => {
    expect(deriveShiftLifecycle({ ...base, gap: 1 })).toBe("DRAFT");
    expect(deriveShiftLifecycle({ ...base, windowKnown: false })).toBe("DRAFT");
  });

  it("gap 0 + window known but not yet published → STAFFED", () => {
    expect(deriveShiftLifecycle(base)).toBe("STAFFED");
  });

  it("published with assignments → PROVISIONED", () => {
    expect(deriveShiftLifecycle({ ...base, published: true })).toBe("PROVISIONED");
    expect(deriveShiftLifecycle({ ...base, gigPosted: true })).toBe("PROVISIONED");
  });

  it("published but zero live assignments stays STAFFED (nothing to notify)", () => {
    expect(deriveShiftLifecycle({ ...base, published: true, assignmentCount: 0 })).toBe("STAFFED");
  });

  it("all packets sent → NOTIFIED; then all confirmed → CONFIRMED; then readiness → READY", () => {
    const provisioned = { ...base, published: true };
    expect(deriveShiftLifecycle({ ...provisioned, allPacketsSent: true })).toBe("NOTIFIED");
    expect(deriveShiftLifecycle({ ...provisioned, allPacketsSent: true, allConfirmed: true })).toBe("CONFIRMED");
    expect(
      deriveShiftLifecycle({ ...provisioned, allPacketsSent: true, allConfirmed: true, readinessReady: true }),
    ).toBe("READY");
  });

  it("start time passed → IN_PROGRESS regardless of confirmation", () => {
    expect(deriveShiftLifecycle({ ...base, now: 15_000 })).toBe("IN_PROGRESS");
  });

  it("a clock-in before start also → IN_PROGRESS", () => {
    expect(deriveShiftLifecycle({ ...base, anyClockIn: true })).toBe("IN_PROGRESS");
  });

  it("end time passed with no blocking exception → COMPLETE", () => {
    expect(deriveShiftLifecycle({ ...base, now: 25_000 })).toBe("COMPLETE");
  });

  it("a blocking exception overlays EXCEPTION on any active phase", () => {
    expect(deriveShiftLifecycle({ ...base, blockingException: true })).toBe("EXCEPTION"); // pre-start
    expect(deriveShiftLifecycle({ ...base, now: 15_000, blockingException: true })).toBe("EXCEPTION"); // in progress
    expect(deriveShiftLifecycle({ ...base, now: 25_000, blockingException: true })).toBe("EXCEPTION"); // blocks completion
  });

  it("unknown end time does not force completion when start passed", () => {
    expect(deriveShiftLifecycle({ ...base, now: 15_000, endMs: null })).toBe("IN_PROGRESS");
  });

  it("isTerminalShiftState", () => {
    expect(isTerminalShiftState("COMPLETE")).toBe(true);
    expect(isTerminalShiftState("CANCELLED")).toBe(true);
    expect(isTerminalShiftState("READY")).toBe(false);
  });
});
