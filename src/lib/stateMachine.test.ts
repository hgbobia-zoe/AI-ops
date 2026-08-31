import { describe, expect, it } from "vitest";
import {
  getAvailableActions,
  isSideAction,
  isTerminal,
  resolveTransition,
} from "./stateMachine";

describe("resolveTransition", () => {
  it("allows the happy-path delivery flow", () => {
    expect(resolveTransition("Waiting", "LEAVING_WAREHOUSE")).toBe("EnRoute");
    expect(resolveTransition("EnRoute", "ARRIVED")).toBe("Arrived");
  });

  it("rejects illegal (from, action) pairs", () => {
    expect(resolveTransition("Waiting", "ARRIVED")).toBeNull();
    expect(resolveTransition("Completed", "LEAVING_WAREHOUSE")).toBeNull();
  });

  it("enforces notLastStop / lastStopOnly on the Arrived branch", () => {
    // HEADING_NEXT only when NOT the last stop.
    expect(resolveTransition("Arrived", "HEADING_NEXT", { isLastStop: false })).toBe("Completed");
    expect(resolveTransition("Arrived", "HEADING_NEXT", { isLastStop: true })).toBeNull();
    // COMPLETE_AND_RETURN only on the last stop.
    expect(resolveTransition("Arrived", "COMPLETE_AND_RETURN", { isLastStop: true })).toBe("Completed");
    expect(resolveTransition("Arrived", "COMPLETE_AND_RETURN", { isLastStop: false })).toBeNull();
  });

  it("guards supervisor-only REOPEN behind isAdmin", () => {
    expect(resolveTransition("Completed", "REOPEN")).toBeNull();
    expect(resolveTransition("Completed", "REOPEN", { isAdmin: true })).toBe("EnRoute");
  });

  it("has no Start-Delivery step (Arrived goes straight to completing)", () => {
    // START_DELIVERY was removed; only HEADING_NEXT / COMPLETE_AND_RETURN / exception exist.
    const fromArrived = getAvailableActions("Arrived", { isLastStop: false }).map((a) => a.action);
    expect(fromArrived).toContain("HEADING_NEXT");
    expect(fromArrived).not.toContain("START_DELIVERY" as never);
  });
});

describe("getAvailableActions", () => {
  it("hides the supervisor REOPEN unless admin", () => {
    expect(getAvailableActions("Completed").map((a) => a.action)).not.toContain("REOPEN");
    expect(getAvailableActions("Completed", { isAdmin: true }).map((a) => a.action)).toContain("REOPEN");
  });

  it("relabels the first departure as 'Head to Customer' for later stops", () => {
    const first = getAvailableActions("Waiting", { isFirstStop: true }).find((a) => a.action === "LEAVING_WAREHOUSE");
    const later = getAvailableActions("Waiting", { isFirstStop: false }).find((a) => a.action === "LEAVING_WAREHOUSE");
    expect(first?.label).toBe("Leaving Warehouse");
    expect(later?.label).toBe("Head to Customer");
  });

  it("marks HEADING_NEXT as checklist-gated", () => {
    const hn = getAvailableActions("Arrived", { isLastStop: false }).find((a) => a.action === "HEADING_NEXT");
    expect(hn?.requiresChecklist).toBe(true);
  });
});

describe("misc", () => {
  it("treats only Returned as terminal", () => {
    expect(isTerminal("Returned")).toBe(true);
    expect(isTerminal("Completed")).toBe(false);
  });

  it("classifies side actions", () => {
    expect(isSideAction("NOTIFY_DISPATCH")).toBe(true);
    expect(isSideAction("GAS_LOG")).toBe(true);
    expect(isSideAction("ARRIVED")).toBe(false);
  });
});
