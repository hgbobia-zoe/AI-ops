import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { ExceptionFollowUps, type FollowUpRow } from "./ExceptionFollowUps";

const row = (over: Partial<FollowUpRow> = {}): FollowUpRow => ({
  key: "risk:sig-1",
  source: "risk",
  status: "unverifiable",
  severity: "high",
  title: "Route has no driver",
  detail: "Assign one",
  nextAction: "Confirm it was handled, then record a disposition.",
  assignedRole: "dispatch",
  escalationTier: "team",
  firstDetectedAt: "2026-11-01T14:00:00.000Z",
  lastSeenAt: "2026-11-02T14:00:00.000Z",
  ...over,
});

const html = (rows: FollowUpRow[]) => renderToStaticMarkup(createElement(ExceptionFollowUps, { rows }));

describe("ExceptionFollowUps", () => {
  it("shows the problem, a plain state, the owner and a Close button", () => {
    const h = html([row()]);
    expect(h).toContain("Route has no driver");
    expect(h).toContain("Needs a check");
    expect(h).toContain("Owner: dispatch");
    expect(h).toContain("Escalated to team");
    expect(h).toContain("Since Nov 1");
    expect(h).toContain(">Close<");
  });

  it("sends in-flight items to their approval instead of offering Close", () => {
    const h = html([row({ status: "awaiting_approval" })]);
    expect(h).toContain("Open approval");
    expect(h).not.toContain(">Close<");
  });

  it("says so plainly when nothing is open", () => {
    expect(html([])).toContain("No open follow-ups");
  });
});
