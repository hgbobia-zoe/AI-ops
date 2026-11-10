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

  it("both drainers assign create_gs_task to the sales lead (active GS user) with a fallback and a due date", () => {
    for (const src of [extSrc, bookmarkletSrc]) {
      expect(src).toContain("/app/project/initProjectSearch");
      expect(src).toContain("salesEnabledUsers");
      expect(src).toContain("assigneeName");
      expect(src).toContain("fallbackUserID");
      expect(src).toContain("gsDueFrom(o.payload.dueDate)");
    }
  });

  it("both pulls re-read GS notes on the lost quotes the server names (lost-reason tracker)", () => {
    for (const src of [extSrc, bookmarkletSrc]) expect(src).toContain("lossNoteIds");
  });

  it("the bookmarklet already handled both (baseline the extension had to reach)", () => {
    expect(bookmarkletSrc).toContain('o.op==="email_send"');
    expect(bookmarkletSrc).toContain('o.op==="create_gs_task"');
  });

  it("both pulls capture the client email thread and the sales lead (timeline + morning outreach context)", () => {
    for (const src of [extSrc, bookmarkletSrc]) {
      expect(src).toContain("/api/gs/emails");
      expect(src).toContain("salesLeadName");
    }
  });

  it("both pulls carry the delivery timing fields (customer window + planned minutes) for on-time tracking", () => {
    for (const src of [extSrc, bookmarkletSrc]) {
      expect(src).toContain("logisticsStartTime");
      expect(src).toContain("logistics_start_from_time");
      expect(src).toContain("earliestRequiredArrivalTime");
      expect(src).toContain("scheduledLoiterMinutes");
      expect(src).toContain("transitMinutes");
    }
  });

  it("both pulls capture the project timeline delivery windows (ranges), one at a time, 250ms apart", () => {
    for (const src of [extSrc, bookmarkletSrc]) {
      expect(src).toContain("/app/vendorTransaction/initProjectTimeline?transactionID=");
      expect(src).toContain('"logisticsDelivery"');
      expect(src).toContain("eventTimeLineMarker");
      expect(src).toContain("dateLabel");
      expect(src).toContain("wait(250)"); // sequential gap: Goodshuffle 429s parallel bursts
      expect(src).toMatch(/status ?=== ?429/); // one retry after a 429
      expect(src).toMatch(/JSON\.stringify\(\{ ?windows: ?wins ?\}\)/);
      // Active lane = non-archived in the horizon; the full lane takes only the archived ones.
      expect(src).toMatch(/pullWindows\(windowIds\(true\)\)/);
      expect(src).toMatch(/pullWindows\(windowIds\(false\)\)/);
      // Never the contract view for this (it carries client notes, not windows).
      expect(src).not.toMatch(/initProjectTimeline[^\n]*initContractView/);
    }
  });

  it("the extension surfaces unhandled op types instead of silently ignoring them", () => {
    // create_project needs a popup from a real user gesture, which a timer-driven content script lacks,
    // so it stays bookmarklet/Playwright-only — but it must be COUNTED and reported, never dropped silently.
    expect(extSrc).toContain("unhandledOps");
    expect(extSrc).toMatch(/unhandled:\s*(unhandledOps\.length|ph\.unhandled)/);
  });
});
