import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildOfficePullScript } from "./gsPull";

// Defect #3 — APPROVED EMAILS NEVER SENT: the browser EXTENSION drainer (extension/pull-injected.js)
// lacked handlers for the email_send / create_gs_task outbox ops that the office bookmarklet
// (src/lib/gsPull.ts) has. An approval is stamped status='executed' the instant the op is enqueued, so
// when the extension was the active drainer those ops sat in the outbox forever and the email never
// left. This guard keeps the two drainers in parity on the supported op types.

const extSrc = readFileSync(fileURLToPath(new URL("../../extension/pull-injected.js", import.meta.url)), "utf8");
const bookmarkletSrc = buildOfficePullScript("https://zoe-dispatch.fly.dev");

describe("extension drainer ↔ bookmarklet parity (defect #3)", () => {
  it("the extension drainer handles email_send", () => {
    expect(extSrc).toContain('o.op === "email_send"');
    // It must actually replay the reply, not just filter it.
    expect(extSrc).toContain("/app/conversation/sendMessage");
    expect(extSrc).toContain('ackOp(o.id, ok, "email_send_failed")');
  });

  it("the extension drainer handles create_gs_task", () => {
    expect(extSrc).toContain('o.op === "create_gs_task"');
    expect(extSrc).toContain("/app/task/createTask");
  });

  it("the bookmarklet already handled both (baseline the extension had to reach)", () => {
    expect(bookmarkletSrc).toContain('o.op==="email_send"');
    expect(bookmarkletSrc).toContain('o.op==="create_gs_task"');
  });

  it("the extension surfaces unhandled op types instead of silently ignoring them", () => {
    // create_project needs a popup from a real user gesture, which a timer-driven content script lacks,
    // so it stays bookmarklet/Playwright-only — but it must be COUNTED and reported, never dropped silently.
    expect(extSrc).toContain("unhandledOps");
    expect(extSrc).toMatch(/unhandled:\s*(unhandledOps\.length|ph\.unhandled)/);
  });
});
