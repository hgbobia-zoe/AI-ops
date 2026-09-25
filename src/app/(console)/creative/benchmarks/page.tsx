// Provider Benchmarking — the experiments worklist. A controlled experiment collects real Zoe data comparing
// image providers under IDENTICAL creative input; it never declares a winner. Dark, dense, Tower-matching.

import Link from "next/link";
import { FlaskConical, Plus, Sparkles } from "lucide-react";
import { listExperiments } from "@/lib/creative/experimentStore";
import { EXPERIMENT_STATUS_LABEL, EXPERIMENT_STATUS_PILL, EXPERIMENT_PHASE_LABEL } from "@/lib/creative/experimentTypes";

export const dynamic = "force-dynamic";

function ago(iso: string): string {
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.round(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function BenchmarksPage(): React.JSX.Element {
  const experiments = listExperiments();

  return (
    <main className="max-w-[1100px] p-6">
      <div className="mb-4 text-[12px] text-meta">
        <Link href="/creative" className="text-tertiary-text hover:text-foreground">Creative Engine</Link> / Provider Benchmarks
      </div>
      <header className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight">
            <FlaskConical className="size-5 text-meta" /> Provider benchmarks
          </h1>
          <p className="mt-1 max-w-2xl text-[12.5px] text-meta">
            Controlled experiments: identical creative input to every provider, only the provider/model changes. Collects real Zoe data on accuracy, approval, and cost per approved image. It does not pick a winner.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href="/creative/benchmarks/new?template=v1"
            className="flex items-center gap-1.5 rounded border border-foreground/30 bg-foreground/10 px-3 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/15"
            title="Start from the Zoe Photography Benchmark V1 template"
          >
            <Sparkles className="size-4" /> Zoe Photography Benchmark V1
          </Link>
          <Link
            href="/creative/benchmarks/new"
            className="flex items-center gap-1.5 rounded border border-border px-3 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-[var(--row-hover)]"
          >
            <Plus className="size-4 text-tertiary-text" /> New experiment
          </Link>
        </div>
      </header>

      {experiments.length === 0 ? (
        <div className="rounded border border-border p-10 text-center">
          <p className="text-[13.5px] text-foreground">No experiments yet.</p>
          <p className="mx-auto mt-1 max-w-md text-[12.5px] text-meta">
            Launch the Zoe Photography Benchmark V1 (OpenAI vs Higgsfield, one generation per provider, blinded human eval) to start collecting data.
          </p>
          <Link href="/creative/benchmarks/new?template=v1" className="mt-4 inline-flex items-center gap-1.5 rounded border border-foreground/30 bg-foreground/10 px-3 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/15">
            <Sparkles className="size-4" /> Start Benchmark V1
          </Link>
        </div>
      ) : (
        <div className="overflow-hidden rounded border border-border">
          <div className="grid grid-cols-[1.8fr_1.1fr_auto_auto_auto] items-center gap-3 border-b border-[var(--row-rule)] bg-panel px-3 py-2 text-[10.5px] font-medium uppercase tracking-[0.07em] text-meta">
            <span>Experiment</span>
            <span>Phase</span>
            <span className="text-right">Sources</span>
            <span className="text-right">Providers</span>
            <span className="text-right">Status</span>
          </div>
          {experiments.map((x) => (
            <Link
              key={x.id}
              href={`/creative/benchmarks/${x.id}`}
              className="grid grid-cols-[1.8fr_1.1fr_auto_auto_auto] items-center gap-3 border-b border-[var(--row-rule)] px-3 py-2.5 text-[12.5px] transition-colors last:border-b-0 hover:bg-[var(--row-hover)]"
            >
              <div className="min-w-0">
                <div className="truncate font-medium text-foreground">
                  {x.seq != null ? <span className="text-meta">#{String(x.seq).padStart(3, "0")} </span> : null}
                  {x.name}
                </div>
                <div className="truncate text-[11px] text-meta">updated {ago(x.startedAt ?? x.createdAt)}</div>
              </div>
              <span className="truncate text-tertiary-text">{EXPERIMENT_PHASE_LABEL[x.phase]}</span>
              <span className="text-right tabular-nums text-meta">{x.frozen.sourceImageIds.length}</span>
              <span className="text-right tabular-nums text-meta">{x.providers.filter((p) => p.enabled).length}</span>
              <span className="flex justify-end">
                <span className={`inline-flex items-center whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-medium ${EXPERIMENT_STATUS_PILL[x.status]}`}>
                  {EXPERIMENT_STATUS_LABEL[x.status]}
                </span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
