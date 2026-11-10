import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The Chrome Web Store rejects an upload whose manifest breaks its field limits ("The description field in
// manifest is too long: 168. It exceeds maximum size limit of 132 characters", 2026-11-10, ext 1.21.1).
// Catch it here instead of at upload time.
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../../extension/manifest.json", import.meta.url)), "utf8")) as {
  name: string;
  short_name?: string;
  description: string;
  version: string;
};

describe("extension manifest fits the Chrome Web Store limits", () => {
  it("description is at most 132 characters", () => {
    expect(manifest.description.length).toBeLessThanOrEqual(132);
  });
  it("name is at most 75 characters", () => {
    expect(manifest.name.length).toBeLessThanOrEqual(75);
  });
  it("version is 1 to 4 dot-separated integers", () => {
    expect(manifest.version).toMatch(/^\d+(\.\d+){0,3}$/);
  });
});
