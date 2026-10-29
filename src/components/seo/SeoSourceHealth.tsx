// Compact source-health strip for the SEO data source (the Google SERP office runner). The DAILY-DEFAULT,
// honest health read: a status indicator + the last successful retrieval, the latest attempt and — only when
// it failed — the actionable failure reason. It never fabricates a "connected" state (status is derived from
// ingest freshness in watcher.ts). The large technical panel + full retrieval log stay behind a disclosure on
// the overview, so this isn't the operator's daily wall of plumbing. Server-component safe.

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Surface } from "@/components/ui/surface";
import { StatusBadge } from "@/components/ui/status";
import { healthTone } from "@/lib/seo/display";
import type { SeoHealth } from "@/lib/seo/types";
import type { SeoWatcherStatus } from "@/lib/seo/watcher";

function ago(iso: string | null): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "unknown";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function SeoSourceHealth({
  health,
  watcher,
  settingsHref = "/admin",
  detailHref = "/admin/health",
}: {
  health: SeoHealth;
  watcher?: SeoWatcherStatus;
  settingsHref?: string;
  detailHref?: string;
}): React.JSX.Element {
  const tone = healthTone(health.status, health.lastError?.toLowerCase().includes("limit") ?? false);
  const failing = health.status === "error";

  return (
    <Surface pad="md" className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-meta">Source · Google SERP</span>
        <StatusBadge tone={tone} size="sm">
          {health.headline}
        </StatusBadge>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
        <dt className="text-meta">Last successful read</dt>
        <dd className={`text-right tabular-nums ${health.lastSuccessAt ? "text-foreground" : "text-meta"}`}>{ago(health.lastSuccessAt)}</dd>
        <dt className="text-meta">Latest attempt</dt>
        <dd className={`text-right tabular-nums ${health.lastAttemptAt ? "text-foreground" : "text-meta"}`}>{ago(health.lastAttemptAt)}</dd>
        {watcher && (
          <>
            <dt className="text-meta">Keywords read</dt>
            <dd className="text-right tabular-nums text-foreground">
              {watcher.discovered}<span className="text-meta"> / {watcher.totalSeeds}</span>
            </dd>
          </>
        )}
      </dl>

      {failing && health.lastError && (
        <p className="border-t border-rule pt-2 text-[12px] text-secondary-text">
          <span className="text-meta">Why it failed: </span>{health.lastError}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-rule pt-2 text-[11.5px]">
        <Link href={settingsHref} className="inline-flex items-center gap-1 text-meta transition-colors hover:text-foreground">
          Source settings <ArrowUpRight className="size-3" />
        </Link>
        <Link href={detailHref} className="inline-flex items-center gap-1 text-meta transition-colors hover:text-foreground">
          Retrieval detail <ArrowUpRight className="size-3" />
        </Link>
      </div>
    </Surface>
  );
}
