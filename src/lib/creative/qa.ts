// AI Quality Control — deterministic QC of a generation against the job's PRESERVE constraints and the
// Visual DNA prohibited list. RULES CALCULATE: the score is a real fraction of checks passed, never a
// fabricated number. HONESTY: with the mock/placeholder provider we cannot inspect pixels, so today's
// checks validate that the BRIEF and constraints are correctly formed and honored — the report is shaped
// so a real vision model can populate the same QaCheck[] later (swap runQa's body, keep the contract).

import { getVisualDNA } from "./visualDna";
import {
  type CreativeJob,
  type Generation,
  type QaCheck,
  type QaReport,
  type ZoeVisualDNA,
  isReferenceFirst,
} from "./types";

const PASS_THRESHOLD = 80; // a generation passes QC at 80+ with no critical failure

/** Run deterministic QC for a generation. Returns a structured report (score + per-check pass/fail). */
export function runQa(job: CreativeJob, generation: Generation, dna: ZoeVisualDNA = getVisualDNA()): QaReport {
  const brief = generation.briefSnapshot;
  const checks: QaCheck[] = [];

  const add = (label: string, pass: boolean, note: string, critical = false): void => {
    checks.push({ label, pass, note, critical });
  };

  // 1. A brief exists (nothing is generated without art direction).
  add(
    "Art direction present",
    !!brief,
    brief ? "Generated from a composed Image Brief." : "No brief snapshot on this generation.",
    true,
  );

  // 2. A result image was produced.
  add(
    "Result produced",
    !!generation.resultPath,
    generation.resultPath ? "Provider returned an image." : "Provider returned no image.",
    true,
  );

  if (brief) {
    // 3. Reference-first: PRESERVE constraints are declared when a real photo anchors the job.
    if (isReferenceFirst(job.sourceMode)) {
      const hasPreserve = brief.preserve.length > 0;
      add(
        "Preserve constraints declared",
        hasPreserve,
        hasPreserve ? `${brief.preserve.length} preserve rule(s) carried into the brief.` : "Reference-first job with no preserve rules — equipment could drift.",
        true,
      );
      // 4. A source image was actually attached (can't preserve from nothing).
      const hasSource = !!job.sourceImageId;
      add(
        "Source of truth attached",
        hasSource,
        hasSource ? "A source photo anchors what must be preserved." : "No source image selected for a reference-first job.",
        true,
      );
      // 5. The no-invented-equipment clause is present in the negatives.
      const guarded = brief.negativeConstraints.some((n) => /invent|add,? remove|alter any rental|physical configuration/i.test(n));
      add(
        "No-invented-equipment guard",
        guarded,
        guarded ? "Brief forbids adding or altering rental equipment." : "Missing the reference-first equipment guard.",
        true,
      );
    } else {
      add("Scratch generation", true, "No source photo; nothing physical to preserve.", false);
    }

    // 6. Every prohibited DNA characteristic is covered by a negative constraint.
    const missing = dna.prohibitedCharacteristics.filter(
      (p) => !brief.negativeConstraints.some((n) => n.toLowerCase().includes(p.toLowerCase().split("/")[0].trim().split(" ")[0])),
    );
    add(
      "Prohibited characteristics constrained",
      missing.length === 0,
      missing.length === 0 ? "All Visual DNA prohibitions are in the negative constraints." : `Not covered: ${missing.slice(0, 3).join("; ")}.`,
      false,
    );

    // 7. Lighting is drawn from the Visual DNA (house consistency).
    const lightingOnBrand = dna.lighting.some((l) => brief.lighting.toLowerCase().includes(l.toLowerCase().split(" ")[0]));
    add("Lighting on-brand", lightingOnBrand, lightingOnBrand ? "Lighting matches the Visual DNA." : "Lighting is not from the Visual DNA set.", false);

    // 8. A composition rule is applied.
    add("Composition rule applied", brief.composition.length > 0, brief.composition ? `Using: ${brief.composition}.` : "No composition rule set.", false);

    // 9. Aspect ratio is explicit.
    add("Aspect ratio specified", !!job.aspectRatio, `Target ratio ${job.aspectRatio}.`, false);
  }

  // 10. Honesty flag: a placeholder is never a real photo.
  if (generation.placeholder) {
    add("Placeholder disclosure", true, "This is a labelled placeholder (mock provider), not a real Zoe photo. Pixel-level QC is pending a vision model.", false);
  }

  const passed = checks.filter((c) => c.pass).length;
  const score = checks.length ? Math.round((passed / checks.length) * 100) : 0;
  const anyCriticalFail = checks.some((c) => c.critical && !c.pass);
  const verdict: "pass" | "fail" = !anyCriticalFail && score >= PASS_THRESHOLD ? "pass" : "fail";

  const summary = anyCriticalFail
    ? "Failed a critical check (missing brief, image, or preserve guard)."
    : verdict === "pass"
      ? `Passed ${passed}/${checks.length} checks (${score}). Brief and constraints are well-formed and honored.`
      : `Scored ${score} (${passed}/${checks.length}); below the ${PASS_THRESHOLD} bar. Regenerate or revise the brief.`;

  return { score, verdict, method: "rules", summary, checks };
}
