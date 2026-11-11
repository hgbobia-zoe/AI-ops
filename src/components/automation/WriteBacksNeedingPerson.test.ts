import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { WriteBacksNeedingPerson, type NeedsPersonRow } from "./WriteBacksNeedingPerson";

const row = (over: Partial<NeedsPersonRow> = {}): NeedsPersonRow => ({
  id: "op1",
  kind: "Delivery fee set",
  label: "delivery fee $50 to a test project",
  state: "failed",
  since: "2026-10-19T14:00:00.000Z",
  lastError: "init_http_500",
  ...over,
});

const html = (rows: NeedsPersonRow[], canDismiss = true) => renderToStaticMarkup(createElement(WriteBacksNeedingPerson, { rows, canDismiss }));

describe("WriteBacksNeedingPerson", () => {
  it("shows what it was, when, why it stopped, and a Dismiss button for a manager", () => {
    const h = html([row(), row({ id: "op2", state: "stuck", label: null, kind: "Invite a person", lastError: null })]);
    expect(h).toContain("delivery fee $50 to a test project");
    expect(h).toContain("Queued Oct 19");
    expect(h).toContain("Last error: init_http_500");
    expect(h).toContain("Failed");
    expect(h).toContain("Stuck");
    expect(h).toContain("Invite a person");
    expect(h).toContain("Dismiss");
  });

  it("hides Dismiss from someone who can't manage settings, and renders nothing when the list is empty", () => {
    expect(html([row()], false)).not.toContain(">Dismiss<");
    expect(html([])).toBe("");
  });
});
