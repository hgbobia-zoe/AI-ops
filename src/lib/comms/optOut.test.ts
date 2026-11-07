import { describe, expect, it } from "vitest";
import { isOptOut } from "./optOut";
import { ingestInboundSms } from "./service";
import { isSuppressed } from "@/lib/prospecting/store";

describe("texted opt out", () => {
  it("recognizes STOP and explicit phrases, not ordinary uses of the word", () => {
    expect(isOptOut("STOP")).toBe(true);
    expect(isOptOut("please remove me")).toBe(true);
    expect(isOptOut("can you stop by Friday?")).toBe(false);
  });

  it("an inbound STOP puts the number on the shared do-not-contact list", () => {
    ingestInboundSms({ providerId: "msg-stop-1", from: "+1 (301) 555-0142", to: "+13012915296", body: "Stop" });
    expect(isSuppressed({ phone: "3015550142" })).toBe(true);
    ingestInboundSms({ providerId: "msg-ok-1", from: "+1 (301) 555-0143", to: "+13012915296", body: "Sounds good, thanks" });
    expect(isSuppressed({ phone: "3015550143" })).toBe(false);
  });
});
