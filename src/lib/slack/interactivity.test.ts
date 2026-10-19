import { afterEach, describe, expect, it } from "vitest";
import { parseInteractivity, decisionForAction, isSlackApprover, APPROVE_ACTION, REJECT_ACTION } from "./interactivity";

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
  it("maps the approve/reject action ids and nothing else", () => {
    expect(decisionForAction(APPROVE_ACTION)).toBe("approve");
    expect(decisionForAction(REJECT_ACTION)).toBe("reject");
    expect(decisionForAction("some_other_button")).toBeNull();
  });
});

describe("isSlackApprover (fail-safe allowlist)", () => {
  it("is nobody when the allowlist is unset", () => {
    expect(isSlackApprover("U123")).toBe(false);
  });
  it("admits only the listed Slack user ids", () => {
    process.env.SLACK_APPROVER_USER_IDS = "U123, U456";
    expect(isSlackApprover("U123")).toBe(true);
    expect(isSlackApprover("U456")).toBe(true);
    expect(isSlackApprover("U999")).toBe(false);
    expect(isSlackApprover("")).toBe(false);
  });
});
