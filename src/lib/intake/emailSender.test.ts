import { describe, it, expect } from "vitest";
import { emailSenderName, opsForDrainer, DEFAULT_EMAIL_SENDER } from "./emailSender";
import { buildOfficePullScript } from "@/lib/gsPull";
import { readFileSync } from "node:fs";

const OPS = [{ op: "email_template" }, { op: "email_send" }, { op: "note_append" }, { op: "photo_upload" }];

describe("email sender hold", () => {
  it("defaults to Jessie Medalla; env overrides; 'any' turns it off", () => {
    expect(emailSenderName({})).toBe(DEFAULT_EMAIL_SENDER);
    expect(DEFAULT_EMAIL_SENDER).toBe("hello@zoeeventsdmv.com"); // the Cindy Gbobia profile
    expect(emailSenderName({ GS_EMAIL_SENDER: "  Lisa McRae " })).toBe("Lisa McRae");
    expect(emailSenderName({ GS_EMAIL_SENDER: "any" })).toBeNull();
    expect(emailSenderName({ GS_EMAIL_SENDER: "off" })).toBeNull();
  });

  it("a drainer that doesn't enforce the hold gets no email ops; one that does gets all", () => {
    expect(opsForDrainer(OPS, false, "Jessie Medalla").map((o) => o.op)).toEqual(["note_append", "photo_upload"]);
    expect(opsForDrainer(OPS, true, "Jessie Medalla")).toHaveLength(4);
    expect(opsForDrainer(OPS, false, null)).toHaveLength(4); // hold off: old drainers send as before
  });

  it("the extension and the bookmarklet both declare the hold and check the signed-in user", () => {
    const ext = readFileSync("extension/pull-injected.js", "utf8");
    const bm = buildOfficePullScript("https://zoe-dispatch.fly.dev");
    for (const src of [ext, bm]) {
      expect(src).toContain("/api/gs/outbox?senderHold=1");
      expect(src).toContain("/app/rms/initHeader");
      expect((src.match(/if\s*\(\s*!senderOk\s*\)/g) ?? []).length).toBe(2); // email_send + email_template
    }
  });
});
