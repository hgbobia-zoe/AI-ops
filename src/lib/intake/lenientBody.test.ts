import { describe, expect, it } from "vitest";
import { escapeControlCharsInStrings, parseLeadBodyText, salvageFlatStringObject } from "./lenientBody";

// The web form Zap builds its body by pasting mapped fields into a JSON template (made-up values).
const zapBody = (message: string) =>
  `{"source": "web", "firstName": "Ana", "lastName": "Reyes", "email": "ana@example.com", "phone": "3015550100", "eventType": "wedding", "eventDate": "2026-12-05", "message": "${message}", "submittedAt": "2026-11-06T21:30:00.000Z"}`;

describe("parseLeadBodyText", () => {
  it("reads valid JSON as is", () => {
    expect(parseLeadBodyText(zapBody("Need 10 tables"))).toMatchObject({ firstName: "Ana", message: "Need 10 tables" });
  });

  it("reads a message with raw line breaks and tabs", () => {
    const out = parseLeadBodyText(zapBody("Hi,\nwe need tents.\r\n\tThanks")) as Record<string, string>;
    expect(out.message).toBe("Hi,\nwe need tents.\r\n\tThanks");
    expect(out.email).toBe("ana@example.com");
  });

  it("reads a message with unescaped quotes", () => {
    const out = parseLeadBodyText(zapBody('We want the "Gold" package, 20" tables')) as Record<string, string>;
    expect(out.message).toBe('We want the "Gold" package, 20" tables');
    expect(out.submittedAt).toBe("2026-11-06T21:30:00.000Z");
    expect(out.firstName).toBe("Ana");
  });

  it("reads quotes and line breaks together", () => {
    const out = parseLeadBodyText(zapBody('Line one\nShe said "yes"')) as Record<string, string>;
    expect(out.message).toBe('Line one\nShe said "yes"');
  });

  it("reads a form encoded body", () => {
    expect(parseLeadBodyText("firstName=Ana&email=ana%40example.com", "application/x-www-form-urlencoded")).toEqual({ firstName: "Ana", email: "ana@example.com" });
  });

  it("returns null for empty or unreadable text", () => {
    expect(parseLeadBodyText("")).toBeNull();
    expect(parseLeadBodyText("   ")).toBeNull();
    expect(parseLeadBodyText("{not json at all")).toBeNull();
  });
});

describe("helpers", () => {
  it("escapes control characters only inside strings", () => {
    expect(escapeControlCharsInStrings('{\n"a": "x\ny"\n}')).toBe('{\n"a": "x\\ny"\n}');
  });

  it("salvage refuses shapes that are not a flat string object", () => {
    expect(salvageFlatStringObject('{"a": 1}')).toBeNull();
    expect(salvageFlatStringObject("[1,2]")).toBeNull();
  });
});
