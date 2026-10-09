// Lifecycle state machine tests — the transition table is the ONLY definition of a legal state change,
// so these assert exactly that: legal forward steps pass, skips fail, trips from any live state pass, and
// nothing leaves a terminal state. Mirrors the improvement-machine test shape. PURE (no DB).

import { describe, it, expect } from "vitest";
import {
  LIFECYCLE_ORDER,
  TERMINAL_STATES,
  canTransition,
  compareLifecycle,
  isLifecycleState,
  isTerminal,
  lifecycleIndex,
  nextStates,
  transition,
  type LifecycleState,
} from "./machine";

const TRIP: LifecycleState[] = ["CANCELLED", "LOST"];
const ALL: LifecycleState[] = [...LIFECYCLE_ORDER, ...TRIP];

describe("machine — happy-path forward steps", () => {
  it("every adjacent forward step along LIFECYCLE_ORDER is legal", () => {
    for (let i = 0; i < LIFECYCLE_ORDER.length - 1; i++) {
      const from = LIFECYCLE_ORDER[i];
      const to = LIFECYCLE_ORDER[i + 1];
      expect(canTransition(from, to)).toBe(true);
      expect(transition(from, to)).toEqual({ ok: true, state: to });
    }
  });

  it("skipping a step (e.g. BOOKED -> DISPATCHED) is illegal", () => {
    expect(canTransition("BOOKED", "DISPATCHED")).toBe(false);
    expect(canTransition("OPPORTUNITY", "BOOKED")).toBe(false);
    expect(canTransition("PLANNING", "LIVE")).toBe(false);
    const res = transition("BOOKED", "DISPATCHED");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("illegal transition BOOKED -> DISPATCHED");
  });

  it("going backwards is illegal", () => {
    expect(canTransition("LIVE", "SETUP")).toBe(false);
    expect(canTransition("CLOSED", "CLOSEOUT")).toBe(false);
    expect(canTransition("QUOTED", "OPPORTUNITY")).toBe(false);
  });

  it("a self-transition is never legal", () => {
    for (const s of ALL) expect(canTransition(s, s)).toBe(false);
  });
});

describe("machine — trip states reachable from any non-terminal state", () => {
  it("CANCELLED and LOST are legal from every non-terminal state", () => {
    for (const from of LIFECYCLE_ORDER.filter((s) => !isTerminal(s))) {
      expect(canTransition(from, "CANCELLED")).toBe(true);
      expect(canTransition(from, "LOST")).toBe(true);
    }
  });

  it("a trip from a terminal state is still illegal", () => {
    for (const from of TERMINAL_STATES) {
      expect(canTransition(from, "CANCELLED")).toBe(false);
      expect(canTransition(from, "LOST")).toBe(false);
    }
  });
});

describe("machine — terminal states", () => {
  it("CLOSED, CANCELLED and LOST are terminal", () => {
    expect(TERMINAL_STATES).toEqual(["CLOSED", "CANCELLED", "LOST"]);
    for (const s of TERMINAL_STATES) expect(isTerminal(s)).toBe(true);
  });

  it("no transition out of any terminal state is legal", () => {
    for (const from of TERMINAL_STATES) {
      for (const to of ALL) expect(canTransition(from, to)).toBe(false);
      expect(nextStates(from)).toEqual([]);
    }
  });

  it("the happy path before CLOSED is not terminal", () => {
    for (const s of LIFECYCLE_ORDER.filter((x) => x !== "CLOSED")) expect(isTerminal(s)).toBe(false);
  });
});

describe("machine — nextStates", () => {
  it("lists the single forward step plus both trips for a mid-path state", () => {
    expect(nextStates("BOOKED").sort()).toEqual(["CANCELLED", "LOST", "PLANNING"].sort());
  });

  it("the last happy step (CLOSEOUT) offers CLOSED plus trips", () => {
    expect(nextStates("CLOSEOUT").sort()).toEqual(["CANCELLED", "CLOSED", "LOST"].sort());
  });

  it("every listed next state is actually a legal transition", () => {
    for (const from of ALL) {
      for (const to of nextStates(from)) expect(canTransition(from, to)).toBe(true);
    }
  });
});

describe("machine — ordering helpers", () => {
  it("lifecycleIndex follows LIFECYCLE_ORDER and is -1 for trip states", () => {
    expect(lifecycleIndex("OPPORTUNITY")).toBe(0);
    expect(lifecycleIndex("CLOSED")).toBe(LIFECYCLE_ORDER.length - 1);
    expect(lifecycleIndex("CANCELLED")).toBe(-1);
    expect(lifecycleIndex("LOST")).toBe(-1);
  });

  it("compareLifecycle orders earlier states before later ones", () => {
    expect(compareLifecycle("OPPORTUNITY", "BOOKED")).toBeLessThan(0);
    expect(compareLifecycle("LIVE", "SETUP")).toBeGreaterThan(0);
    expect(compareLifecycle("PLANNING", "PLANNING")).toBe(0);
  });
});

describe("machine — isLifecycleState", () => {
  it("accepts known states and rejects anything else", () => {
    for (const s of ALL) expect(isLifecycleState(s)).toBe(true);
    expect(isLifecycleState("READY_TO_BOOK")).toBe(false);
    expect(isLifecycleState("")).toBe(false);
    expect(isLifecycleState(42)).toBe(false);
    expect(isLifecycleState(null)).toBe(false);
  });
});
