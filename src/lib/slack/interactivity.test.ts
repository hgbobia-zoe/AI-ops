import { afterEach, describe, expect, it } from "vitest";
import {
  parseInteractivity,
  decisionForAction,
  isSlackApprover,
  decidedCardView,
  APPROVE_ACTION,
  REJECT_ACTION,
  REQUEST_CHANGES_ACTION,
} from "./interactivity";

function encode(payload: unknown): string {
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

afterEach(() => {
  delete process.env.SLACK_APPROVER_USER_IDS;
});

describe("parseInteractivity", () => {
  it("pulls the clicked action, value, user, and response_url from a block_actions payload", () => {
    const body = encode({
      type: "block_actions",
      user: { id: "U123", username: "hermann" },
      channel: { id: "C999" },
      message: { ts: "1700000000.0001" },
      response_url: "https://hooks.slack.com/actions/XXX",
      actions: [{ action_id: APPROVE_ACTION, value: "AP-abc" }],
    });
    const a = parseInteractivity(body)!;
    expect(a.actionId).toBe(APPROVE_ACTION);
    expect(a.value).toBe("AP-abc");
    expect(a.userId).toBe("U123");
    expect(a.userName).toBe("hermann");
    expect(a.responseUrl).toBe("https://hooks.slack.com/actions/XXX");
    expect(a.channel).toBe("C999");
  });

  it("returns null for a non-block_actions payload, missing payload, or malformed json", () => {
    expect(parseInteractivity(encode({ type: "view_submission", actions: [] }))).toBeNull();
    expect(parseInteractivity("nothing=here")).toBeNull();
    expect(parseInteractivity("payload=not-json")).toBeNull();
    expect(parseInteractivity(encode({ type: "block_actions", actions: [] }))).toBeNull();
  });
});

describe("decisionForAction", () => {
  it("maps the approve/reject/request-changes action ids and nothing else", () => {
    expect(decisionForAction(APPROVE_ACTION)).toBe("approve");
    expect(decisionForAction(REJECT_ACTION)).toBe("reject");
    expect(decisionForAction(REQUEST_CHANGES_ACTION)).toBe("request_info");
    expect(decisionForAction("some_other_button")).toBeNull();
  });
});

describe("decidedCardView (renders the REAL stored state, never the click's intent)", () => {
  it("shows queued for an executed approval, held for an approved-but-not-sent one", () => {
    expect(decidedCardView("executed")).toMatchObject({ emoji: "✅", byLabel: "Approved by" });
    expect(decidedCardView("executed").title.toLowerCase()).toContain("queued");
    expect(decidedCardView("approved")).toMatchObject({ byLabel: "Approved by" });
    expect(decidedCardView("approved").title.toLowerCase()).toContain("held");
  });
  it("never claims success for a failed execution", () => {
    const v = decidedCardView("failed");
    expect(v.emoji).toBe("⚠️");
    expect(v.title.toLowerCase()).not.toContain("approved");
    expect(v.title.toLowerCase()).toContain("not sent");
  });
  it("labels dismissed and change-requested states distinctly", () => {
    expect(decidedCardView("rejected")).toMatchObject({ title: "Dismissed", byLabel: "Dismissed by" });
    expect(decidedCardView("info_requested").byLabel).toBe("Requested by");
    expect(decidedCardView("info_requested").title.toLowerCase()).toContain("app");
  });
});

describe("isSlackApprover (fail-safe allowlist)", () => {
  it("is nobody when the allowlist is unset", () => {
    expect(isSlackApprover("U123")).toBe(false);
  });
  it("admits only the listed Slack user ids (env fallback when no ids passed)", () => {
    process.env.SLACK_APPROVER_USER_IDS = "U123, U456";
    expect(isSlackApprover("U123")).toBe(true);
    expect(isSlackApprover("U456")).toBe(true);
    expect(isSlackApprover("U999")).toBe(false);
    expect(isSlackApprover("")).toBe(false);
  });
  it("uses the passed id list (the route's settings-resolved allowlist) over the env", () => {
    process.env.SLACK_APPROVER_USER_IDS = "U123"; // env says U123…
    // …but the explicit list (from settings) is authoritative when provided.
    expect(isSlackApprover("U123", ["U456"])).toBe(false);
    expect(isSlackApprover("U456", ["U456"])).toBe(true);
    expect(isSlackApprover("U456", [])).toBe(false); // empty list = nobody
  });
});
