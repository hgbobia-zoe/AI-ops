"use client";

// The jobs list control bar: search, lifecycle-stage / asset-type / campaign filters, sort, and a
// grid/list view switch. Every control writes to the URL query string (not local state), so the selected
// filters, sort and view are PRESERVED across navigation — opening a job and pressing Back returns to the
// same filtered view, and the view is shareable/bookmarkable. Only supported fields are offered.

import { useCallback, useEffect, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Search, LayoutGrid, List, X } from "lucide-react";
import { ASSET_TYPES, ASSET_TYPE_LABEL, JOB_STATUS_ORDER, JOB_STATUS_LABEL, type JobStatus } from "@/lib/creative/types";
import { JOB_SORTS, JOB_SORT_LABEL, type JobFilter } from "@/lib/creative/jobView";

const ALL_STATUSES: JobStatus[] = [...JOB_STATUS_ORDER, "rejected"];

const fieldCls =
  "h-8 rounded border border-input bg-row px-2 text-[12.5px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function CreativeFilters({
  filter,
  view,
  campaigns,
}: {
  filter: JobFilter;
  view: "grid" | "list";
  campaigns: string[];
}): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState(filter.q);

  // Keep the local search box in sync if the URL's query changes from elsewhere (back/forward) — the
  // sanctioned "adjust state while rendering when a prop changes" pattern, so we avoid a setState effect.
  const [prevFilterQ, setPrevFilterQ] = useState(filter.q);
  if (filter.q !== prevFilterQ) {
    setPrevFilterQ(filter.q);
    setQ(filter.q);
  }

  const setParam = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "" || v === "all") next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  // Debounce the search box so typing does not push a history entry per keystroke.
  useEffect(() => {
    const id = setTimeout(() => {
      if (q !== filter.q) setParam({ q: q || null });
    }, 300);
    return () => clearTimeout(id);
  }, [q, filter.q, setParam]);

  const hasFilters = filter.q || filter.status !== "all" || filter.type !== "all" || filter.campaign !== "all";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-0 flex-1 basis-56">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-meta" aria-hidden />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search title, campaign, page…"
          aria-label="Search creative jobs"
          className="h-8 w-full rounded border border-input bg-row pl-7 pr-2 text-[12.5px] text-foreground placeholder:text-meta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      <select
        aria-label="Filter by lifecycle stage"
        className={fieldCls}
        value={filter.status}
        onChange={(e) => setParam({ status: e.target.value })}
      >
        <option value="all">All stages</option>
        {ALL_STATUSES.map((s) => (
          <option key={s} value={s}>
            {JOB_STATUS_LABEL[s]}
          </option>
        ))}
      </select>

      <select
        aria-label="Filter by asset type"
        className={fieldCls}
        value={filter.type}
        onChange={(e) => setParam({ type: e.target.value })}
      >
        <option value="all">All types</option>
        {ASSET_TYPES.map((t) => (
          <option key={t} value={t}>
            {ASSET_TYPE_LABEL[t]}
          </option>
        ))}
      </select>

      {campaigns.length > 0 && (
        <select
          aria-label="Filter by campaign"
          className={fieldCls}
          value={filter.campaign}
          onChange={(e) => setParam({ campaign: e.target.value })}
        >
          <option value="all">All campaigns</option>
          {campaigns.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      )}

      <select
        aria-label="Sort by"
        className={fieldCls}
        value={filter.sort}
        onChange={(e) => setParam({ sort: e.target.value })}
      >
        {JOB_SORTS.map((s) => (
          <option key={s} value={s}>
            {JOB_SORT_LABEL[s]}
          </option>
        ))}
      </select>

      <button
        type="button"
        aria-label={`Sort direction: ${filter.dir === "asc" ? "ascending" : "descending"}`}
        title={filter.dir === "asc" ? "Ascending" : "Descending"}
        onClick={() => setParam({ dir: filter.dir === "asc" ? null : "asc" })}
        className="h-8 rounded border border-input bg-row px-2 text-[12.5px] text-tertiary-text hover:bg-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {filter.dir === "asc" ? "↑" : "↓"}
      </button>

      {hasFilters && (
        <button
          type="button"
          onClick={() => setParam({ q: null, status: null, type: null, campaign: null })}
          className="inline-flex h-8 items-center gap-1 rounded border border-input bg-row px-2 text-[12px] text-meta hover:bg-row-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3.5" aria-hidden /> Clear
        </button>
      )}

      {/* View switch */}
      <div className="ml-auto inline-flex overflow-hidden rounded border border-input" role="group" aria-label="View">
        <button
          type="button"
          aria-label="Grid view"
          aria-pressed={view === "grid"}
          onClick={() => setParam({ view: null })}
          className={`flex h-8 w-8 items-center justify-center transition-colors ${view === "grid" ? "bg-foreground/[0.08] text-foreground" : "bg-row text-meta hover:text-foreground"}`}
        >
          <LayoutGrid className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          aria-label="List view"
          aria-pressed={view === "list"}
          onClick={() => setParam({ view: "list" })}
          className={`flex h-8 w-8 items-center justify-center border-l border-input transition-colors ${view === "list" ? "bg-foreground/[0.08] text-foreground" : "bg-row text-meta hover:text-foreground"}`}
        >
          <List className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
