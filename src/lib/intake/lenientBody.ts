// Lead webhook bodies are often hand-built JSON in a Zap ("message": "{{form message}}"), so a customer who types
// a line break, a quote or a backslash breaks the JSON and the lead never becomes a project. This reads such
// bodies anyway. Order: real JSON, then form-encoded, then JSON with raw control characters escaped, then a
// salvage of a flat {"key": "value", ...} object whose string values contain unescaped quotes. Pure, never throws.

/** Escape raw newlines, tabs and other control characters that sit inside JSON string literals. */
export function escapeControlCharsInStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        out += ch;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : `\\u${code.toString(16).padStart(4, "0")}`;
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

const unescapeLoose = (v: string): string =>
  v.replace(/\\(["\\/nrt])/g, (_, c: string) => (c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c));

/**
 * Salvage a flat object of string values, e.g. {"firstName": "Ana", "message": "she said "hi""}. A value runs until
 * the next `", "key":` or the closing `"}`. Returns null when the text is not that shape.
 */
export function salvageFlatStringObject(text: string): Record<string, string> | null {
  const m = text.trim().match(/^\{\s*"([\s\S]*)"\s*\}$/);
  if (!m) return null;
  const parts = m[1].split(/"\s*,\s*"(?=[A-Za-z_][\w-]*"\s*:\s*")/);
  const out: Record<string, string> = {};
  for (const part of parts) {
    const kv = part.match(/^([A-Za-z_][\w-]*)"\s*:\s*"([\s\S]*)$/);
    if (!kv) return null;
    out[kv[1]] = unescapeLoose(kv[2]);
  }
  return Object.keys(out).length ? out : null;
}

function tryJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Parse a lead webhook body. Returns null only when nothing usable can be read. */
export function parseLeadBodyText(text: string, contentType = ""): unknown | null {
  const t = text.replace(/^﻿/, "").trim();
  if (!t) return null;

  const direct = tryJson(t);
  if (direct.ok) return direct.value;

  if (/application\/x-www-form-urlencoded/i.test(contentType) || (!t.startsWith("{") && !t.startsWith("[") && /^[^=&\s]+=/.test(t))) {
    const params = new URLSearchParams(t);
    const obj: Record<string, string> = {};
    for (const [k, v] of params) obj[k] = v;
    if (Object.keys(obj).length) return obj;
  }

  const repaired = tryJson(escapeControlCharsInStrings(t));
  if (repaired.ok) return repaired.value;

  return salvageFlatStringObject(t);
}
