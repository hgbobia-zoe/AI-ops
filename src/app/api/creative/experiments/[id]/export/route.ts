// Provider Benchmarking — raw data export (spec §24). One row per generation matrix cell (run) with the
// experiment/case/source/provider/model, the reused generation, its automated QA, the human evaluation, the
// approval, failure reasons, cost, and timing. `?format=csv` (default) or `?format=json`. Nothing derived is
// invented — missing cost/QA export as empty, never a fabricated value.

import { NextResponse } from "next/server";
import { buildDetail } from "@/lib/creative/experimentService";

export const dynamic = "force-dynamic";

const csvCell = (v: unknown): string => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const COLUMNS = [
  "experiment_id", "experiment_name", "phase", "status",
  "test_case_id", "test_case_seq", "source_image_id", "source_version",
  "provider_run_id", "provider_id", "provider_name", "model", "blind_label",
  "generation_id", "executor_provider", "executed_model", "placeholder", "run_status",
  "qa_method", "qa_decision", "qa_verdict", "qa_score",
  "qa_productAccuracy", "qa_referenceFidelity", "qa_photographicQuality", "qa_architecturalRealism",
  "qa_humanRealism", "qa_brandAlignment", "qa_composition", "qa_webUsability", "qa_hardFailures",
  "human_productAccuracy", "human_realism", "human_brandFit", "human_composition", "human_usability",
  "human_overallApproval", "human_decision", "human_notes", "evaluator",
  "failure_categories", "failure_notes",
  "cost_total", "cost_input", "cost_output", "cost_currency", "cost_known",
  "generation_time_ms", "paired_preference", "preference_note",
];

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse | Response> {
  const { id } = await params;
  const detail = buildDetail(id);
  if (!detail) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const format = new URL(req.url).searchParams.get("format") === "json" ? "json" : "csv";

  const { experiment, cases, runs, evals, failures, generations } = detail;
  const caseById = new Map(cases.map((c) => [c.id, c]));
  const evalByRun = new Map(evals.map((e) => [e.runId, e]));
  const failByRun = new Map<string, typeof failures>();
  for (const f of failures) failByRun.set(f.runId, [...(failByRun.get(f.runId) ?? []), f]);

  const rows = runs.map((r) => {
    const c = caseById.get(r.caseId);
    const gen = r.generationId ? generations[r.generationId] : undefined;
    const qa = gen?.qaReport ?? null;
    const dims = qa?.dimensions;
    const ev = evalByRun.get(r.id);
    const fails = failByRun.get(r.id) ?? [];
    const cost = gen?.cost;
    // preference: resolve a run-id preference back to its blind label for readability
    let pref = c?.preference ?? "";
    if (pref && pref !== "both" && pref !== "neither") {
      const wr = runs.find((x) => x.id === pref);
      pref = wr ? `TEST ${wr.blindLabel}` : pref;
    }
    return {
      experiment_id: experiment.id,
      experiment_name: experiment.name,
      phase: experiment.phase,
      status: experiment.status,
      test_case_id: r.caseId,
      test_case_seq: c?.seq ?? "",
      source_image_id: c?.sourceImageId ?? "",
      source_version: c?.sourceVersion ?? "",
      provider_run_id: r.id,
      provider_id: r.providerId,
      provider_name: experiment.providers.find((p) => p.id === r.providerRefId)?.providerName ?? "",
      model: r.model ?? "",
      blind_label: r.blindLabel,
      generation_id: r.generationId ?? "",
      executor_provider: gen?.provider ?? "",
      executed_model: gen?.model ?? "",
      placeholder: gen ? (gen.placeholder ? "yes" : "no") : "",
      run_status: r.status,
      qa_method: qa?.method ?? "",
      qa_decision: qa?.decision ?? "",
      qa_verdict: qa?.verdict ?? "",
      qa_score: qa?.score ?? "",
      qa_productAccuracy: dims?.productAccuracy ?? "",
      qa_referenceFidelity: dims?.referenceFidelity ?? "",
      qa_photographicQuality: dims?.photographicQuality ?? "",
      qa_architecturalRealism: dims?.architecturalRealism ?? "",
      qa_humanRealism: dims?.humanRealism ?? "",
      qa_brandAlignment: dims?.brandAlignment ?? "",
      qa_composition: dims?.composition ?? "",
      qa_webUsability: dims?.webUsability ?? "",
      qa_hardFailures: (qa?.hardFailures ?? []).join("; "),
      human_productAccuracy: ev?.productAccuracy ?? "",
      human_realism: ev?.realism ?? "",
      human_brandFit: ev?.brandFit ?? "",
      human_composition: ev?.composition ?? "",
      human_usability: ev?.usability ?? "",
      human_overallApproval: ev?.overallApproval ?? "",
      human_decision: ev?.decision ?? "",
      human_notes: ev?.notes ?? "",
      evaluator: ev?.evaluator ?? "",
      failure_categories: fails.map((f) => f.category).join("; "),
      failure_notes: fails.map((f) => f.note).filter(Boolean).join(" | "),
      cost_total: cost?.total ?? "",
      cost_input: cost?.input ?? "",
      cost_output: cost?.output ?? "",
      cost_currency: cost?.currency ?? "",
      cost_known: cost ? (cost.known ? "yes" : "no") : "",
      generation_time_ms: gen?.processingMs ?? "",
      paired_preference: pref,
      preference_note: c?.preferenceNote ?? "",
    } as Record<string, unknown>;
  });

  const base = `benchmark-${experiment.seq ?? experiment.id}`;
  if (format === "json") {
    return new NextResponse(JSON.stringify({ experiment, metrics: detail.metrics, rows }, null, 2), {
      headers: { "content-type": "application/json", "content-disposition": `attachment; filename="${base}.json"` },
    });
  }
  const lines = [COLUMNS.join(","), ...rows.map((row) => COLUMNS.map((k) => csvCell(row[k])).join(","))];
  return new NextResponse(lines.join("\n"), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${base}.csv"` },
  });
}
