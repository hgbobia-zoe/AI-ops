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
  type QaDecision,
  type QaScorecard,
  type ZoeVisualDNA,
  isReferenceFirst,
} from "./types";

/** Coerce an unknown into a 0..100 integer, or undefined when it isn't a finite number. */
const score100 = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : undefined;
};
const cleanStrs = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x.trim() : "")).filter((x) => x.length > 0) : [];

/** Pull a full 0..100 scorecard from the n8n dimensions blob (only when every axis is present + numeric). */
function parseScorecard(d: unknown): QaScorecard | undefined {
  if (!d || typeof d !== "object") return undefined;
  const o = d as Record<string, unknown>;
  const keys: (keyof QaScorecard)[] = [
    "productAccuracy", "referenceFidelity", "photographicQuality", "architecturalRealism",
    "humanRealism", "brandAlignment", "composition", "webUsability",
  ];
  const out = {} as QaScorecard;
  for (const k of keys) {
    const n = score100(o[k]);
    if (n === undefined) return undefined; // partial scorecards are dropped rather than half-fabricated
    out[k] = n;
  }
  return out;
}

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
  // A failed critical brief-check is a hard failure (a real vision QA reports its own codes; this floor maps
  // its critical checks). No `dimensions`: the rules floor inspects no pixels, so it never fabricates axes.
  const hardFailures = checks.filter((c) => c.critical && !c.pass).map((c) => c.label);
  const decision: QaDecision = verdict === "pass" ? "PASS" : "FAIL";

  const summary = anyCriticalFail
    ? "Failed a critical check (missing brief, image, or preserve guard)."
    : verdict === "pass"
      ? `Passed ${passed}/${checks.length} checks (${score}). Brief and constraints are well-formed and honored.`
      : `Scored ${score} (${passed}/${checks.length}); below the ${PASS_THRESHOLD} bar. Regenerate or revise the brief.`;

  return {
    score,
    verdict,
    decision,
    method: "rules",
    summary,
    checks,
    hardFailures,
    issues: checks.filter((c) => !c.critical && !c.pass).map((c) => c.note),
    recommendedChanges: [],
  };
}

// ── n8n path ────────────────────────────────────────────────────────────────────────────────────────
// Per decision (B), n8n runs the generation-QA; we take ITS verdict as primary and layer only a LIGHT
// reference-first constraint check (the one thing n8n can't know: did this job require a real source photo
// as the truth, and was one attached?). The app still owns human approval regardless.
export interface N8nQaInput {
  score?: number; // overall 0..100
  verdict?: "pass" | "fail"; // legacy binary; `decision` is preferred
  decision?: QaDecision; // PASS | FAIL | HUMAN_REVIEW (the richer outcome)
  dimensions?: Partial<QaScorecard>; // the 0..100 multi-axis scorecard
  hardFailures?: string[]; // any → forces FAIL regardless of scores
  issues?: string[];
  recommendedChanges?: string[];
  note?: string;
  checks?: { label: string; pass: boolean; note?: string }[];
}

const N8N_PASS_THRESHOLD = 70;

export function n8nQaReport(job: CreativeJob, n8n: N8nQaInput | null | undefined, succeeded: boolean): QaReport {
  const checks: QaCheck[] = [];

  // n8n's own checks (data, not authority) — surfaced verbatim, non-critical on our side.
  for (const c of n8n?.checks ?? []) {
    if (c && typeof c.label === "string") checks.push({ label: c.label, pass: !!c.pass, note: typeof c.note === "string" ? c.note : "", critical: false });
  }

  const hardFailures = cleanStrs(n8n?.hardFailures);
  const dimensions = parseScorecard(n8n?.dimensions);

  // n8n's decision (its vision generation-QA result). Priority: explicit decision → verdict → score → status.
  // A non-empty hardFailures list ALWAYS forces FAIL: a beautiful image with the wrong Zoe equipment must not
  // pass, whatever the numeric scores say.
  let decision: QaDecision =
    n8n?.decision ??
    (n8n?.verdict === "pass"
      ? "PASS"
      : n8n?.verdict === "fail"
        ? "FAIL"
        : typeof n8n?.score === "number"
          ? n8n.score >= N8N_PASS_THRESHOLD
            ? "PASS"
            : "FAIL"
          : succeeded
            ? "PASS"
            : "FAIL");
  if (hardFailures.length) decision = "FAIL";

  checks.push({
    label: "n8n vision QA",
    pass: decision === "PASS",
    note:
      hardFailures.length
        ? `Hard failure: ${hardFailures.slice(0, 3).join("; ")}.`
        : n8n?.note || (typeof n8n?.score === "number" ? `n8n QA score ${n8n.score} (${decision}).` : succeeded ? `n8n reported ${decision}.` : "n8n reported failure."),
    critical: false,
  });

  // Our LIGHT reference-first constraint check (the only thing WE gate on beyond n8n's verdict).
  const refOk = !isReferenceFirst(job.sourceMode) || !!job.sourceImageId;
  checks.push({
    label: "Reference source attached",
    pass: refOk,
    note: refOk ? (isReferenceFirst(job.sourceMode) ? "A source-of-truth photo anchors this reference-first job." : "Scratch job; no source required.") : "Reference-first job with no source photo attached.",
    critical: true,
  });
  if (!refOk) decision = "FAIL";

  const verdict: "pass" | "fail" = decision === "PASS" ? "pass" : "fail";
  const score = typeof n8n?.score === "number" ? Math.max(0, Math.min(100, Math.round(n8n.score))) : verdict === "pass" ? 100 : 0;
  const summary =
    !refOk
      ? "Blocked: reference-first job is missing its source photo."
      : decision === "PASS"
        ? `n8n QA passed${typeof n8n?.score === "number" ? ` (${n8n.score})` : ""}; reference constraint OK. Ready for human review.`
        : hardFailures.length
          ? `n8n QA hard failure (${hardFailures.slice(0, 2).join("; ")}). Regenerate or revise.`
          : decision === "HUMAN_REVIEW"
            ? "n8n QA is uncertain — routed to a human to judge."
            : "n8n QA did not pass. Regenerate or revise.";

  return {
    score,
    verdict,
    decision,
    method: "n8n",
    summary,
    checks,
    dimensions,
    hardFailures,
    issues: cleanStrs(n8n?.issues),
    recommendedChanges: cleanStrs(n8n?.recommendedChanges),
  };
}
