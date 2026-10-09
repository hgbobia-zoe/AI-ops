import { describe, expect, it } from "vitest";
import {
  isRequestTerminal,
  statusForPrAttached,
  createRequest,
  getRequest,
  setRequestStatus,
  attachRequestPr,
  listRequests,
  listOpenRequests,
  countRequestsByStatus,
  countOpenRequests,
} from "./requests";

describe("request pure helpers", () => {
  it("classifies terminal status", () => {
    expect(isRequestTerminal("done")).toBe(true);
    expect(isRequestTerminal("declined")).toBe(true);
    expect(isRequestTerminal("new")).toBe(false);
    expect(isRequestTerminal("in_review")).toBe(false);
  });
  it("moves to in_review when a PR is attached, unless already closed", () => {
    expect(statusForPrAttached("new")).toBe("in_review");
    expect(statusForPrAttached("in_progress")).toBe("in_review");
    expect(statusForPrAttached("done")).toBe("done"); // closed — unchanged
    expect(statusForPrAttached("declined")).toBe("declined");
  });
});

describe("request store", () => {
  it("files a request, idempotent on changeKey", () => {
    const a = createRequest({ title: "Capture route changes after schedules", type: "feature", blade: "scheduling", requestedBy: "Lisa", sessionId: "AS-x", body: "full text", changeKey: "req:AE-1" });
    expect(a.id).toMatch(/^REQ-/);
    expect(a.status).toBe("new");
    expect(a.type).toBe("feature");
    const again = createRequest({ title: "different title", type: "question", changeKey: "req:AE-1" });
    expect(again.id).toBe(a.id); // same row, not a duplicate
    expect(again.title).toBe("Capture route changes after schedules"); // original preserved
  });

  it("changes status with notes and audits", () => {
    const r = createRequest({ title: "Add dark mode", type: "feature" });
    const triaged = setRequestStatus(r.id, "triaged", { notes: "good idea, queued", actor: "Hermann" });
    expect(triaged?.status).toBe("triaged");
    expect(triaged?.notes).toBe("good idea, queued");
    expect(setRequestStatus("REQ-nope", "done")).toBeNull();
  });

  it("attaches a PR and moves to in_review", () => {
    const r = createRequest({ title: "Implement X", type: "feature" });
    const withPr = attachRequestPr(r.id, { url: "https://github.com/o/r/pull/42", number: 42, branch: "feat/x" }, "AI responder");
    expect(withPr?.status).toBe("in_review");
    expect(withPr?.prUrl).toBe("https://github.com/o/r/pull/42");
    expect(withPr?.prNumber).toBe(42);
    expect(withPr?.branch).toBe("feat/x");
    // closing then attaching a PR does not reopen
    const closed = createRequest({ title: "Closed one", type: "feature" });
    setRequestStatus(closed.id, "declined");
    const after = attachRequestPr(closed.id, { url: "https://github.com/o/r/pull/43" });
    expect(after?.status).toBe("declined");
  });

  it("lists, filters, and counts", () => {
    const openBefore = countOpenRequests();
    const f = createRequest({ title: "Feature A", type: "feature" });
    createRequest({ title: "Question B", type: "question" });
    expect(countOpenRequests()).toBe(openBefore + 2);

    const features = listRequests({ type: "feature" });
    expect(features.every((x) => x.type === "feature")).toBe(true);
    expect(features.some((x) => x.id === f.id)).toBe(true);

    const news = listRequests({ status: "new" });
    expect(news.every((x) => x.status === "new")).toBe(true);

    setRequestStatus(f.id, "done");
    expect(listOpenRequests().some((x) => x.id === f.id)).toBe(false);
    expect(getRequest(f.id)?.status).toBe("done");

    const counts = countRequestsByStatus();
    expect(counts.done).toBeGreaterThanOrEqual(1);
  });
});
