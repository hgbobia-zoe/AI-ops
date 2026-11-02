import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GS_TEMPLATE_JS, gsTemplateRenderers } from "./gsTemplate";
import { buildOfficePullScript } from "@/lib/gsPull";

const { gsRenderTemplate, gsTemplateText } = gsTemplateRenderers();

// Tag values as GET /app/messageTemplate/list?transactionID=<id> returns them for a real project.
const TAGS = [
  { name: "ProjectName", transactionValue: "Smith - Wedding" },
  { name: "ProjectID", transactionValue: "231976451" },
  { name: "FirstName", transactionValue: "Pat" },
  { name: "BusinessName", transactionValue: "Zoe Events & Party Rentals" },
  { name: "VenueAddress", transactionValue: null },
];

const chip = (value: string, original: string, inner = `#${value}`) =>
  `<span class="mention" data-index="2" data-denotation-char="#" data-id="3" data-value="${value}" data-original="${original}">${inner}</span>`;

describe("gsRenderTemplate", () => {
  it("swaps each variable chip for the project's value", () => {
    const html = `<div>Hello ${chip("First Name", "FirstName")},</div><div>Your project is ${chip("Project ID", "ProjectID")}.</div>`;
    expect(gsRenderTemplate(html, TAGS)).toBe("<div>Hello Pat,</div><div>Your project is 231976451.</div>");
  });

  it("handles the nested spans the Goodshuffle editor sometimes writes", () => {
    const inner = `<span contenteditable="false"><span class="ql-mention-denotation-char">#</span>First Name</span>`;
    expect(gsRenderTemplate(`<div>Hi ${chip("First Name", "FirstName", inner)}!</div>`, TAGS)).toBe("<div>Hi Pat!</div>");
  });

  it("matches a chip by data-value when data-original is missing, ignoring spaces and case", () => {
    const html = `<div>(Project <span class="mention" data-denotation-char="#" data-value="Project ID"></span>)</div>`;
    expect(gsRenderTemplate(html, TAGS)).toBe("<div>(Project 231976451)</div>");
  });

  it("escapes values and empties unknown or blank variables; FirstName falls back to 'there'", () => {
    const html = `<div>${chip("Business Name", "BusinessName")}|${chip("Venue Address", "VenueAddress")}|${chip("Nope", "Nope")}</div>`;
    expect(gsRenderTemplate(html, TAGS)).toBe("<div>Zoe Events &amp; Party Rentals||</div>");
    expect(gsRenderTemplate(`<div>Hello ${chip("First Name", "FirstName")}</div>`, [])).toBe("<div>Hello there</div>");
  });

  it("leaves text without chips untouched", () => {
    expect(gsRenderTemplate("<div>Plain <b>bold</b></div>", TAGS)).toBe("<div>Plain <b>bold</b></div>");
  });
});

describe("gsTemplateText", () => {
  it("turns the HTML subject into plain text", () => {
    const subject = `<div>We Received Your Event Request (Project ${chip("Project ID", "ProjectID", "")})</div>`;
    expect(gsTemplateText(gsRenderTemplate(subject, TAGS))).toBe("We Received Your Event Request (Project 231976451)");
    expect(gsTemplateText("<div>A &amp; B</div><div><br></div>")).toBe("A & B");
  });
});

describe("drainer parity", () => {
  it("the extension carries a verbatim copy of the renderer", () => {
    // Line endings normalized: a Windows checkout turns the file's LF into CRLF.
    const ext = readFileSync(fileURLToPath(new URL("../../../extension/pull-injected.js", import.meta.url)), "utf8").replace(/\r\n/g, "\n");
    expect(ext).toContain(GS_TEMPLATE_JS);
    expect(ext).toContain('o.op === "email_template"');
  });

  it("the bookmarklet carries the renderer and the handler", () => {
    const bm = buildOfficePullScript("https://zoe-dispatch.fly.dev");
    expect(bm).toContain(GS_TEMPLATE_JS);
    expect(bm).toContain('o.op==="email_template"');
    expect(GS_TEMPLATE_JS).not.toContain("#"); // a "#" can cut a javascript: bookmarklet URL short
  });
});
