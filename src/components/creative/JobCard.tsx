// One job as a thumbnail-led grid card. Server component (it is a Link wrapping the client <JobThumb>).
// Surfaces the facts the spec asks for up front: preview, title, asset type, dimensions + aspect ratio,
// campaign, lifecycle status, last-updated, and the single next valid action. The whole card links to the
// detail, where actions are actually performed.

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { StatusPill } from "./StatusPill";
import { JobThumb } from "./JobThumb";
import { ASSET_TYPE_LABEL, ASPECT_RATIO_SHORT, aspectDimensions, type CreativeJob } from "@/lib/creative/types";
import { nextAction, type ThumbPick } from "@/lib/creative/jobView";

function ago(iso: string): string {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function JobCard({ job, thumb }: { job: CreativeJob; thumb: ThumbPick | null }): React.JSX.Element {
  const dims = aspectDimensions(job.aspectRatio);
  const action = nextAction(job);
  return (
    <Link
      href={`/creative/${job.id}`}
      className="surface group flex flex-col overflow-hidden rounded-md border border-border transition-colors hover:bg-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <JobThumb
        src={thumb?.path ?? null}
        ratio={job.aspectRatio}
        alt={`${job.title} preview`}
        placeholder={thumb?.placeholder}
        origin={thumb?.origin}
        rounded="rounded-none"
        className="border-0 border-b"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="line-clamp-2 min-w-0 text-[13px] font-medium leading-snug text-foreground">{job.title}</h3>
          <StatusPill status={job.status} className="shrink-0" />
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-meta">
          <span className="text-tertiary-text">{ASSET_TYPE_LABEL[job.assetType]}</span>
          <span aria-hidden>·</span>
          <span className="tabular-nums">
            {ASPECT_RATIO_SHORT[job.aspectRatio]} · {dims.w}×{dims.h}
          </span>
          {job.campaign && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{job.campaign}</span>
            </>
          )}
        </div>
        <div className="mt-auto flex items-center justify-between gap-2 border-t border-rule pt-2 text-[11px]">
          <span className="text-meta">Updated {ago(job.updatedAt)}</span>
          <span className={`inline-flex items-center gap-1 ${action.actionable ? "text-foreground" : "text-meta"}`}>
            {action.label}
            {action.actionable && <ArrowRight className="size-3 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />}
          </span>
        </div>
      </div>
    </Link>
  );
}
