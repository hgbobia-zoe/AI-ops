// Creative Engine — Jobs. The worklist of every creative asset and its lifecycle position. Dense, dark,
// Tower-matching. Each row links to the job detail. Read-only server render (mutations happen on detail).

import Link from "next/link";
import { Images, Plus } from "lucide-react";
import { listJobs } from "@/lib/creative/store";
import { ASSET_TYPE_LABEL } from "@/lib/creative/types";
import { StatusPill } from "@/components/creative/StatusPill";

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

export default function CreativeJobsPage(): React.JSX.Element {
  const jobs = listJobs();

  return (
    <main className="max-w-[1100px] p-6">
      <div className="mb-4 text-[12px] text-meta">
        <span className="text-tertiary-text">Creative Engine</span> / Jobs
      </div>
      <header className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight">
            <Images className="size-5 text-meta" /> Creative jobs
          </h1>
          <p className="mt-1 text-[12.5px] text-meta">
            AI creates, rules constrain, AI evaluates, humans approve. Every asset&apos;s position in the pipeline is always visible.
          </p>
        </div>
        <Link
          href="/creative/new"
          className="flex shrink-0 items-center gap-1.5 rounded border border-border px-3 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-[var(--row-hover)]"
        >
          <Plus className="size-4 text-tertiary-text" /> New job
        </Link>
      </header>

      {jobs.length === 0 ? (
        <div className="rounded border border-border p-10 text-center">
          <p className="text-[13.5px] text-foreground">No creative jobs yet.</p>
          <p className="mx-auto mt-1 max-w-md text-[12.5px] text-meta">
            Start one to define an asset, let the Art Director compose the brief from the Zoe Visual DNA, generate, and review.
          </p>
          <Link href="/creative/new" className="mt-4 inline-flex items-center gap-1.5 rounded border border-border px-3 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-[var(--row-hover)]">
            <Plus className="size-4 text-tertiary-text" /> New creative job
          </Link>
        </div>
      ) : (
        <div className="overflow-hidden rounded border border-border">
          <div className="grid grid-cols-[1.8fr_0.9fr_1.1fr_auto_auto_auto] items-center gap-3 border-b border-[var(--row-rule)] bg-panel px-3 py-2 text-[10.5px] font-medium uppercase tracking-[0.07em] text-meta">
            <span>Asset</span>
            <span>Type</span>
            <span>Page / section</span>
            <span className="text-right">QA</span>
            <span className="text-right">Gens</span>
            <span className="text-right">Status</span>
          </div>
          {jobs.map((j) => (
            <Link
              key={j.id}
              href={`/creative/${j.id}`}
              className="grid grid-cols-[1.8fr_0.9fr_1.1fr_auto_auto_auto] items-center gap-3 border-b border-[var(--row-rule)] px-3 py-2.5 text-[12.5px] transition-colors last:border-b-0 hover:bg-[var(--row-hover)]"
            >
              <div className="min-w-0">
                <div className="truncate font-medium text-foreground">{j.title}</div>
                <div className="truncate text-[11px] text-meta">
                  {j.campaign ? `${j.campaign} · ` : ""}
                  updated {ago(j.updatedAt)}
                </div>
              </div>
              <span className="truncate text-tertiary-text">{ASSET_TYPE_LABEL[j.assetType]}</span>
              <span className="truncate text-meta">{[j.page, j.section].filter(Boolean).join(" / ") || "—"}</span>
              <span className="text-right tabular-nums text-tertiary-text">{j.qaScore == null ? "—" : j.qaScore}</span>
              <span className="text-right tabular-nums text-meta">{j.generationCount}</span>
              <span className="flex justify-end">
                <StatusPill status={j.status} />
              </span>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
