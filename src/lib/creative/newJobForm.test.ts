// Unit tests for the New Creative Job form logic (pure, no DB, no React). Covers the required/optional
// contract, the source-mode-dependent source-image requirement, the earliest-error-step jump, the create
// payload shaping (incl. dropping the source image on a from-scratch job), and the contextual summary.

import { describe, it, expect } from "vitest";
import {
  INITIAL_FIELDS,
  STEPS,
  stepIndex,
  validateNewJob,
  firstErrorStep,
  buildJobPayload,
  defaultsFor,
  summaryLines,
  filledBriefCount,
  type NewJobFields,
} from "./newJobForm";
import { defaultPreserve, defaultTransform } from "./types";

const fields = (over: Partial<NewJobFields> = {}): NewJobFields => ({ ...INITIAL_FIELDS, ...over });

describe("INITIAL_FIELDS — visible, sensible defaults", () => {
  it("defaults to a from-scratch lifestyle job at 3:2 with real selected values", () => {
    expect(INITIAL_FIELDS.sourceMode).toBe("scratch");
    expect(INITIAL_FIELDS.assetType).toBe("lifestyle");
    expect(INITIAL_FIELDS.aspectRatio).toBe("3:2");
    // Defaults are concrete values, not blank placeholders.
    expect(INITIAL_FIELDS.transform).toEqual(defaultTransform("lifestyle"));
    // From scratch has nothing physical to preserve.
    expect(INITIAL_FIELDS.preserve).toEqual([]);
  });
});

describe("validateNewJob — only title and (when reference-first) a source image are required", () => {
  it("rejects a blank title", () => {
    const errs = validateNewJob(fields({ title: "   " }));
    expect(errs.map((e) => e.field)).toContain("title");
    expect(errs.find((e) => e.field === "title")?.step).toBe("brief");
  });

  it("accepts a from-scratch job with just a title (no source image needed)", () => {
    expect(validateNewJob(fields({ title: "Hero", sourceMode: "scratch" }))).toEqual([]);
  });

  it("requires a source image for upload mode", () => {
    const errs = validateNewJob(fields({ title: "Hero", sourceMode: "upload", sourceImageId: null }));
    expect(errs.map((e) => e.field)).toContain("sourceImageId");
    expect(errs.find((e) => e.field === "sourceImageId")?.message).toMatch(/upload the source photo/i);
  });

  it("requires a source image for existing mode, with the right resolution text", () => {
    const errs = validateNewJob(fields({ title: "Hero", sourceMode: "existing", sourceImageId: null }));
    expect(errs.find((e) => e.field === "sourceImageId")?.message).toMatch(/existing zoe image/i);
  });

  it("passes reference-first once a source image is chosen", () => {
    expect(validateNewJob(fields({ title: "Hero", sourceMode: "upload", sourceImageId: "CI-1" }))).toEqual([]);
  });

  it("reports both errors when title and source image are missing together", () => {
    const errs = validateNewJob(fields({ title: "", sourceMode: "existing", sourceImageId: null }));
    expect(errs.map((e) => e.field).sort()).toEqual(["sourceImageId", "title"]);
  });
});

describe("firstErrorStep — a failed submit lands on the earliest offending step", () => {
  it("prefers the source step over the brief step (source comes first)", () => {
    const errs = validateNewJob(fields({ title: "", sourceMode: "upload", sourceImageId: null }));
    expect(firstErrorStep(errs)).toBe("source");
  });
  it("returns null when there are no errors", () => {
    expect(firstErrorStep([])).toBeNull();
  });
  it("keeps the declared step order", () => {
    expect(stepIndex("source")).toBeLessThan(stepIndex("brief"));
    expect(STEPS.map((s) => s.id)).toEqual(["source", "asset", "brief", "direction"]);
  });
});

describe("buildJobPayload — shapes the real inputs into CreativeJobInput", () => {
  it("passes reference-first fields through, keeping the chosen source image", () => {
    const p = buildJobPayload(fields({ title: "Hero", sourceMode: "existing", sourceImageId: "CI-42", product: "Sailcloth tent" }));
    expect(p.sourceMode).toBe("existing");
    expect(p.sourceImageId).toBe("CI-42");
    expect(p.product).toBe("Sailcloth tent");
    expect(p.preserve).toEqual(INITIAL_FIELDS.preserve);
    expect(p.transform).toEqual(INITIAL_FIELDS.transform);
  });

  it("drops the source image on a from-scratch job even if one was previously picked", () => {
    const p = buildJobPayload(fields({ title: "Hero", sourceMode: "scratch", sourceImageId: "CI-99" }));
    expect(p.sourceImageId).toBeNull();
  });
});

describe("defaultsFor — PRESERVE/TRANSFORM defaults track the mode + asset type", () => {
  it("matches the shared type defaults", () => {
    expect(defaultsFor("upload", "hero")).toEqual({
      preserve: defaultPreserve("upload", "hero"),
      transform: defaultTransform("hero"),
    });
  });
  it("yields an empty preserve list for scratch (nothing physical anchors it)", () => {
    expect(defaultsFor("scratch", "lifestyle").preserve).toEqual([]);
  });
});

describe("summary helpers — honest read-back, never fabricated", () => {
  it("renders blanks as a dash, not an invented value", () => {
    const lines = summaryLines(INITIAL_FIELDS);
    expect(lines.every((l) => l.value === "—")).toBe(true);
  });
  it("reflects filled values", () => {
    const lines = summaryLines(fields({ product: "Tent", campaign: "Spring 2026" }));
    expect(lines.find((l) => l.label === "Product")?.value).toBe("Tent");
    expect(lines.find((l) => l.label === "Campaign")?.value).toBe("Spring 2026");
  });
  it("counts only filled optional brief fields", () => {
    expect(filledBriefCount(INITIAL_FIELDS)).toEqual({ filled: 0, total: 7 });
    expect(filledBriefCount(fields({ product: "Tent", objective: "luxury" }))).toEqual({ filled: 2, total: 7 });
  });
});
