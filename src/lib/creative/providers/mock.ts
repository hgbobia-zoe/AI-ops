// Mock image provider — a deterministic, zero-dependency stand-in so the ENTIRE creative lifecycle runs
// end-to-end with no external API key. It never pretends to be a real photo: it returns a clearly-labelled
// SVG "brief card" (the composed direction rendered as a placeholder), and every result carries
// placeholder:true so the store, the UI, and QA all disclose it honestly. Deterministic per (job, attempt)
// so re-runs are reproducible.

import { aspectDimensions } from "../types";
import type { ImageGenerationInput, ImageGenerationProvider, ImageGenerationResult } from "./types";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Wrap text to a rough character width, returning up to `maxLines` lines. */
function wrap(text: string, perLine: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > perLine) {
      lines.push(cur.trim());
      cur = w;
      if (lines.length >= maxLines) break;
    } else {
      cur = (cur + " " + w).trim();
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur.trim());
  if (lines.length === maxLines && words.length) lines[maxLines - 1] = lines[maxLines - 1].replace(/[.,]?$/, "…");
  return lines;
}

/** A subtle deterministic hue from the job id, so different jobs read as visually distinct cards. */
function hueFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

function renderSvg(input: ImageGenerationInput, mode: "generate" | "edit"): string {
  const { w, h } = aspectDimensions(input.aspectRatio);
  const hue = hueFromId(input.jobId);
  const brief = input.brief;
  const pad = Math.round(w * 0.06);
  const conceptLines = wrap(brief.creativeConcept, Math.round(w / 16), 3);
  const subjectLines = wrap(brief.subject, Math.round(w / 15), 2);

  const lineTag = (label: string, value: string, y: number): string =>
    `<text x="${pad}" y="${y}" font-family="Georgia, serif" font-size="${Math.round(w * 0.016)}" fill="#c9c9c9"><tspan fill="#8a8a8a">${esc(label)}  </tspan>${esc(value)}</text>`;

  const conceptTspans = conceptLines
    .map((l, i) => `<tspan x="${pad}" dy="${i === 0 ? 0 : Math.round(w * 0.03)}">${esc(l)}</tspan>`)
    .join("");
  const subjectTspans = subjectLines
    .map((l, i) => `<tspan x="${pad}" dy="${i === 0 ? 0 : Math.round(w * 0.022)}">${esc(l)}</tspan>`)
    .join("");

  const midY = Math.round(h * 0.34);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue},14%,11%)"/>
      <stop offset="1" stop-color="hsl(${(hue + 40) % 360},16%,6%)"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <rect x="${Math.round(pad / 2)}" y="${Math.round(pad / 2)}" width="${w - pad}" height="${h - pad}" fill="none" stroke="hsl(${hue},22%,32%)" stroke-width="2"/>
  <text x="${pad}" y="${Math.round(h * 0.11)}" font-family="Helvetica, Arial, sans-serif" font-size="${Math.round(w * 0.014)}" letter-spacing="3" fill="#9a8f70">ZOE CREATIVE ENGINE · PLACEHOLDER · NOT A REAL PHOTO</text>
  <text x="${pad}" y="${Math.round(h * 0.2)}" font-family="Georgia, serif" font-size="${Math.round(w * 0.03)}" fill="#f0ece0">${conceptTspans}</text>
  <text x="${pad}" y="${midY}" font-family="Georgia, serif" font-size="${Math.round(w * 0.024)}" fill="#dcd5c4">${subjectTspans}</text>
  ${lineTag("LIGHTING", brief.lighting, Math.round(h * 0.5))}
  ${lineTag("LENS", brief.lens, Math.round(h * 0.55))}
  ${lineTag("COMPOSITION", brief.composition, Math.round(h * 0.6))}
  ${lineTag("COLOR", brief.colorGrade, Math.round(h * 0.65))}
  ${lineTag("MODE", mode === "edit" ? "reference-first edit (source preserved)" : "generate from scratch", Math.round(h * 0.7))}
  ${lineTag("RATIO", input.aspectRatio, Math.round(h * 0.75))}
  ${lineTag("ATTEMPT", String(input.attempt), Math.round(h * 0.8))}
  <text x="${pad}" y="${h - pad}" font-family="Helvetica, Arial, sans-serif" font-size="${Math.round(w * 0.012)}" fill="#7a7a7a">${esc(brief.preserve.length ? "Preserve: " + brief.preserve.slice(0, 2).join(", ") : "No physical source to preserve")}</text>
</svg>`;
}

export const mockProvider: ImageGenerationProvider = {
  id: "mock",
  label: "Mock (placeholder, no key)",
  configured(): boolean {
    return true;
  },
  async generate(input: ImageGenerationInput): Promise<ImageGenerationResult> {
    return {
      ok: true,
      svg: renderSvg(input, "generate"),
      url: null,
      model: "mock-placeholder-v1",
      placeholder: true,
      meta: { mode: "generate", aspectRatio: input.aspectRatio, briefSource: input.brief.briefSource },
    };
  },
  async edit(input: ImageGenerationInput): Promise<ImageGenerationResult> {
    return {
      ok: true,
      svg: renderSvg(input, "edit"),
      url: null,
      model: "mock-placeholder-v1",
      placeholder: true,
      meta: { mode: "edit", aspectRatio: input.aspectRatio, sourceImageId: input.sourceImage?.id ?? null },
    };
  },
};
