// Creative Engine — Jobs. The worklist of every creative asset and its real lifecycle position. Thumbnail-
// led grid (default) or a dense list, with supported filters/search/sort whose state lives in the URL so it
// survives navigation. Read-only server render; every mutation happens on the job detail.
//
// Honesty: the grid shows only REAL available pixels (saved asset → latest generation → source photo), with
// an explicit fallback when there is none, and a "Placeholder" badge on mock generations. Nothing here
// claims completed generation or fabricates a populated library.

import Link from "next/link";
import { Images, Plus, FlaskConical, Dna } from "lucide-react";
import { listJobs, jobThumbnails } from "@/lib/creative/store";
import { ASSET_TYPE_LABEL, ASPECT_RATIO_SHORT, aspectDimensions } from "@/lib/creative/types";
import { PageHeader } from "@/components/ui/page-header";
import { BladeMain } from "@/components/ui/layouts";
import { Metric } from "@/components/ui/metric";
import { EmptyState } from "@/components/ui/states";
import { buttonVariants } from "@/components/ui/button";
import { StatusPill } from "@/components/creative/StatusPill";
import { JobCard } from "@/components/creative/JobCard";
import { JobThumb } from "@/components/creative/JobThumb";
import { CreativeFilters } from "@/components/creative/CreativeFilters";
import {
  parseJobFilter,
  filterJobs,
  campaignOptions,
  phaseCounts,
  nextAction,
} from "@/lib/creative/jobView";

export const dynamic = "force-dynamic";

function ago(iso: string): string {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default async function CreativeJobsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const allJobs = listJobs();
  const filter = parseJobFilter(sp);
  const view = (Array.isArray(sp.view) ? sp.view[0] : sp.view) === "list" ? "list" : "grid";
  const jobs = filterJobs(allJobs, filter);
  const thumbs = jobThumbnails(jobs);
  const counts = phaseCounts(allJobs);
  const campaigns = campaignOptions(allJobs);

  const secondaryLinks = (
    <>
      <Link href="/creative/benchmarks" className={buttonVariants({ variant: "outline", size: "default" })}>
        <FlaskConical className="text-tertiary-text" /> Provider Benchmarks
      </Link>
      <Link href="/creative/dna" className={buttonVariants({ variant: "outline", size: "default" })}>
        <Dna className="text-tertiary-text" /> Visual DNA
      </Link>
      <Link href="/creative/new" className={buttonVariants({ variant: "default", size: "default" })}>
        <Plus /> New job
      </Link>
    </>
  );

  return (
    <BladeMain>
      <PageHeader
        icon={<Images className="size-5" />}
        title="Creative jobs"
        subtitle="AI creates, rules constrain, AI evaluates, humans approve. Every asset's position in the pipeline stays visible — approval is not publication."
        actions={secondaryLinks}
      />

      {allJobs.length === 0 ? (
        <EmptyState
          icon={<Images className="size-6" />}
          title="No creative jobs yet"
          body="Start one to define an asset, let the Art Director compose the brief from the Zoe Visual DNA, generate, and review. Nothing is generated or published until you act."
          action={
            <Link href="/creative/new" className={buttonVariants({ variant: "default", size: "default" })}>
              <Plus /> New creative job
            </Link>
          }
        />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Metric label="Jobs" value={counts.total} sub="in the library" />
            <Metric label="In progress" value={counts.in_progress} tone="info" sub="drafting → QC" />
            <Metric label="Awaiting review" value={counts.awaiting_review} tone="attention" sub="needs a human" />
            <Metric label="Approved" value={counts.approved} tone="positive" sub="not yet saved" />
            <Metric label="Saved assets" value={counts.published} tone="positive" sub="published" />
          </div>

          <CreativeFilters filter={filter} view={view} campaigns={campaigns} />

          {jobs.length === 0 ? (
            <EmptyState
              title="No jobs match these filters"
              body="Try a different lifecycle stage, asset type or campaign, or clear the search."
              action={
                <Link href="/creative" className={buttonVariants({ variant: "outline", size: "default" })}>
                  Clear filters
                </Link>
              }
            />
          ) : view === "grid" ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {jobs.map((j) => (
                <JobCard key={j.id} job={j} thumb={thumbs.get(j.id) ?? null} />
              ))}
            </div>
          ) : (
            <div className="surface overflow-x-auto rounded-md border border-border">
              <table className="w-full min-w-[720px] text-[12.5px]">
                <thead>
                  <tr className="border-b border-rule text-left text-[10.5px] uppercase tracking-[0.06em] text-meta">
                    <th className="px-3 py-2 font-medium">Asset</th>
                    <th className="px-3 py-2 font-medium">Type · ratio</th>
                    <th className="px-3 py-2 font-medium">Campaign / page</th>
                    <th className="px-3 py-2 text-right font-medium">QA</th>
                    <th className="px-3 py-2 text-right font-medium">Gens</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Next</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => {
                    const thumb = thumbs.get(j.id) ?? null;
                    const dims = aspectDimensions(j.aspectRatio);
                    const action = nextAction(j);
                    return (
                      <tr key={j.id} className="border-b border-rule/60 last:border-0 hover:bg-row-hover">
                        <td className="px-3 py-2">
                          <Link href={`/creative/${j.id}`} className="flex items-center gap-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            <span className="w-12 shrink-0">
                              <JobThumb
                                src={thumb?.path ?? null}
                                ratio={j.aspectRatio}
                                alt={`${j.title} preview`}
                                placeholder={thumb?.placeholder}
                                origin={thumb?.origin}
                              />
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate font-medium text-foreground">{j.title}</span>
                              <span className="block truncate text-[11px] text-meta">updated {ago(j.updatedAt)}</span>
                            </span>
                          </Link>
                        </td>
                        <td className="px-3 py-2 text-tertiary-text">
                          {ASSET_TYPE_LABEL[j.assetType]}
                          <span className="ml-1 tabular-nums text-meta">· {ASPECT_RATIO_SHORT[j.aspectRatio]} · {dims.w}×{dims.h}</span>
                        </td>
                        <td className="px-3 py-2 text-meta">{[j.campaign, [j.page, j.section].filter(Boolean).join(" / ")].filter(Boolean).join(" · ") || "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-tertiary-text">{j.qaScore == null ? "—" : j.qaScore}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-meta">{j.generationCount}</td>
                        <td className="px-3 py-2"><StatusPill status={j.status} /></td>
                        <td className={`px-3 py-2 ${action.actionable ? "text-foreground" : "text-meta"}`}>{action.label}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </BladeMain>
  );
}
