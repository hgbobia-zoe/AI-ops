import { describe, expect, it } from "vitest";
import { requesterChannelLine, canDmRequester } from "./notify";

describe("requester notify helpers", () => {
  it("names the requester in the channel line, or passes text through when unknown", () => {
    expect(requesterChannelLine("Lisa", "your request is in")).toBe("For Lisa: your request is in");
    expect(requesterChannelLine("  Lisa  ", "hi")).toBe("For Lisa: hi");
    expect(requesterChannelLine(null, "hi")).toBe("hi");
    expect(requesterChannelLine("   ", "hi")).toBe("hi");
    expect(requesterChannelLine(undefined, "hi")).toBe("hi");
  });

  it("only DMs when a bot token AND an email are present", () => {
    expect(canDmRequester(true, "lisa@zoe.com")).toBe(true);
    expect(canDmRequester(false, "lisa@zoe.com")).toBe(false); // no token
    expect(canDmRequester(true, null)).toBe(false); // no email
    expect(canDmRequester(true, "   ")).toBe(false); // blank email
    expect(canDmRequester(false, null)).toBe(false);
  });
});
