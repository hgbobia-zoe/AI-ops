// People lifecycle machine tests — the transition table is the ONLY definition of a legal state change.
// Legal forward steps pass, skips fail, the OFFBOARD trip is legal from any live state, OFFBOARDED is
// terminal, and OFFBOARD→OFFBOARDED is the only forward exit of OFFBOARD. PURE (no DB). Mirrors the
// event-machine test shape.

import { describe, it, expect } from "vitest";
import {
  LIFECYCLE_ORDER,
  TERMINAL_STATES,
  canTransition,
  isLifecycleState,
  isTerminal,
  lifecycleIndex,
  nextStates,
  transition,
  type LifecycleState,
} from "./machine";

const ALL: LifecycleState[] = ["HIRE", "ONBOARD", "READY", "ACTIVE", "OFFBOARD", "OFFBOARDED"];

describe("people machine — happy path", () => {
  it("every adjacent forward step along LIFECYCLE_ORDER is legal", () => {
    for (let i = 0; i < LIFECYCLE_ORDER.length - 1; i++) {
      expect(canTransition(LIFECYCLE_ORDER[i], LIFECYCLE_ORDER[i + 1])).toBe(true);
      expect(transition(LIFECYCLE_ORDER[i], LIFECYCLE_ORDER[i + 1])).toEqual({ ok: true, state: LIFECYCLE_ORDER[i + 1] });
    }
  });

  it("skipping a step is illegal", () => {
    expect(canTransition("HIRE", "READY")).toBe(false);
    expect(canTransition("HIRE", "ACTIVE")).toBe(false);
    expect(canTransition("ONBOARD", "ACTIVE")).toBe(false);
    const res = transition("HIRE", "ACTIVE");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("illegal transition HIRE -> ACTIVE");
  });

  it("going backwards is illegal", () => {
    expect(canTransition("ACTIVE", "READY")).toBe(false);
    expect(canTransition("READY", "ONBOARD")).toBe(false);
  });

  it("a self-transition is never legal", () => {
    for (const s of ALL) expect(canTransition(s, s)).toBe(false);
  });
});

describe("people machine — OFFBOARD trip from anywhere", () => {
  it("OFFBOARD is legal from every non-terminal state", () => {
    for (const from of ["HIRE", "ONBOARD", "READY", "ACTIVE"] as LifecycleState[]) {
      expect(canTransition(from, "OFFBOARD")).toBe(true);
    }
  });

  it("OFFBOARD's only forward exit is OFFBOARDED", () => {
    expect(canTransition("OFFBOARD", "OFFBOARDED")).toBe(true);
    expect(nextStates("OFFBOARD")).toEqual(["OFFBOARDED"]);
  });

  it("you cannot trip to OFFBOARD from a terminal state", () => {
    expect(canTransition("OFFBOARDED", "OFFBOARD")).toBe(false);
  });
});

describe("people machine — terminal", () => {
  it("only OFFBOARDED is terminal", () => {
    expect(TERMINAL_STATES).toEqual(["OFFBOARDED"]);
    expect(isTerminal("OFFBOARDED")).toBe(true);
    for (const s of ["HIRE", "ONBOARD", "READY", "ACTIVE", "OFFBOARD"] as LifecycleState[]) expect(isTerminal(s)).toBe(false);
  });

  it("no transition leaves OFFBOARDED", () => {
    for (const to of ALL) expect(canTransition("OFFBOARDED", to)).toBe(false);
    expect(nextStates("OFFBOARDED")).toEqual([]);
  });
});

describe("people machine — nextStates + helpers", () => {
  it("a live state offers its forward step plus the OFFBOARD trip", () => {
    expect(nextStates("HIRE").sort()).toEqual(["OFFBOARD", "ONBOARD"].sort());
    expect(nextStates("ACTIVE")).toEqual(["OFFBOARD"]); // ACTIVE's only exit is offboarding
  });

  it("every listed next state is actually legal", () => {
    for (const from of ALL) for (const to of nextStates(from)) expect(canTransition(from, to)).toBe(true);
  });

  it("lifecycleIndex follows the order and is -1 off-path", () => {
    expect(lifecycleIndex("HIRE")).toBe(0);
    expect(lifecycleIndex("ACTIVE")).toBe(3);
    expect(lifecycleIndex("OFFBOARD")).toBe(-1);
    expect(lifecycleIndex("OFFBOARDED")).toBe(-1);
  });

  it("isLifecycleState narrows known states only", () => {
    for (const s of ALL) expect(isLifecycleState(s)).toBe(true);
    expect(isLifecycleState("FIRED")).toBe(false);
    expect(isLifecycleState(42)).toBe(false);
    expect(isLifecycleState(null)).toBe(false);
  });
});
