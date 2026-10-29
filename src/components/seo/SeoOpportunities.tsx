"use client";

// SEO Growth — Opportunities. A list/table with a board-view toggle and local stage + search filters; each
// opportunity opens in the shared side panel for the evidence, recommendation, priority breakdown and the
// opportunity-approval decision. A "Discover" action (owner/admin) runs the pull. HONEST empty / setup states:
// with no SERP reads nothing is discovered and we say so, leading with the real settings destination — never
// faking rows. Filters persist in the URL (?stage, ?q), so a reload restores the operator's view.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, LayoutGrid, Table as TableIcon, Loader2, Sparkles, ArrowUpRight, X } from "lucide-react";
import Link from "next/link";
import { SidePanelOverlay } from "@/components/SidePanelOverlay";
import { SeoOpportunityPanel } from "@/components/seo/SeoOpportunityPanel";
import { SeoBoard } from "@/components/seo/SeoBoard";
import { BladeMain } from "@/components/ui/layouts";
import { PageHeader, Toolbar } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status";
import { StatusBanner, EmptyState } from "@/components/ui/states";
import { tableCls, theadCls, thCls, tdCls, rowCls } from "@/components/console-primitives";
import { BOARD_STAGES, STAGE_META } from "@/lib/seo/stages";
import { stageTone } from "@/lib/seo/display";
import type { SeoHealth, SeoOpportunity, SeoStage } from "@/lib/seo/types";

/** Recommended-action label (a tag, not a status — kept neutral; colour is reserved for real status). */
function ActionLabel({ action }: { action: SeoOpportunity["recommendedAction"] }): React.JSX.Element {
  if (!action) return <span className="text-meta">—</span>;
  return <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-secondary-text">{action}</span>;
}

export function SeoOpportunities({
  opportunities,
  health,
  initialStage = "",
  initialQuery = "",
}: {
  opportunities: SeoOpportunity[];
  health: SeoHealth;
  initialStage?: SeoStage | "";
  initialQuery?: string;
}): React.JSX.Element {
  const router = useRouter();
  const [view, setView] = useState<"table" | "board">("table");
  const [openId, setOpenId] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [stage, setStage] = useState<SeoStage | "">(initialStage);
  const [query, setQuery] = useState(initialQuery);

  // Persist filters to the URL (no server round trip) so a reload restores them — the server reads them back.
  function syncUrl(nextStage: SeoStage | "", nextQuery: string): void {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (nextStage) params.set("stage", nextStage); else params.delete("stage");
    if (nextQuery.trim()) params.set("q", nextQuery.trim()); else params.delete("q");
    const qs = params.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }

  function changeStage(next: SeoStage | ""): void {
    setStage(next);
    syncUrl(next, query);
  }
  function changeQuery(next: string): void {
    setQuery(next);
    syncUrl(stage, next);
  }

  async function discover(): Promise<void> {
    setDiscovering(true);
    setMsg(null);
    try {
      const r = await fetch("/api/seo/discover", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const data = (await r.json()) as { ok?: boolean; result?: { note?: string }; error?: string };
      setMsg(data.result?.note ?? data.error ?? "Done.");
      router.refresh();
    } catch {
      setMsg("Discovery failed — network error.");
    } finally {
      setDiscovering(false);
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return opportunities.filter((o) => {
      if (stage && o.stage !== stage) return false;
      if (q && !(o.keyword.toLowerCase().includes(q) || (o.category ?? "").toLowerCase().includes(q))) return false;
      return true;
    });
  }, [opportunities, stage, query]);

  const noData = opportunities.length === 0;
  const noMatches = !noData && filtered.length === 0;
  const activeFilter = Boolean(stage || query.trim());

  return (
    <BladeMain className="max-w-[1200px]">
      <PageHeader
        icon={<Search className="size-5" />}
        title="Opportunities"
        subtitle="Keyword opportunities matched against Zoe's site, each with a recommended action, an explainable priority, and the first approval gate."
        actions={
          <>
            <div className="inline-flex rounded border border-border p-0.5" role="tablist" aria-label="View">
              <button type="button" role="tab" aria-selected={view === "table"} onClick={() => setView("table")} className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[12px] transition-colors ${view === "table" ? "bg-row-hover text-foreground" : "text-meta hover:text-foreground"}`}>
                <TableIcon className="size-3.5" /> Table
              </button>
              <button type="button" role="tab" aria-selected={view === "board"} onClick={() => setView("board")} className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[12px] transition-colors ${view === "board" ? "bg-row-hover text-foreground" : "text-meta hover:text-foreground"}`}>
                <LayoutGrid className="size-3.5" /> Board
              </button>
            </div>
            <button type="button" onClick={() => void discover()} disabled={discovering} className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-foreground transition-colors hover:bg-row-hover disabled:opacity-50">
              {discovering ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} Discover
            </button>
          </>
        }
      />

      {msg && (
        <StatusBanner tone="info" title="Discovery" edge={false} className="mb-3">
          {msg}
        </StatusBanner>
      )}

      {!health.configured && (
        <StatusBanner
          tone="neutral"
          title="No SERP reads yet"
          className="mb-3"
          action={
            <Link href="/admin" className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-foreground transition-colors hover:bg-row-hover">
              Open source settings <ArrowUpRight className="size-3.5" />
            </Link>
          }
        >
          There is nothing to discover until the source reads. Set the Zoe + competitor domains in Settings, then
          run the Google SERP office runner. The pipeline is live and populates once it reads.
        </StatusBanner>
      )}

      {/* Local filters — stage + search. Shown once there is data to filter. */}
      {!noData && view === "table" && (
        <Toolbar justify="start" className="mb-3">
          <label className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-meta" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => changeQuery(e.target.value)}
              placeholder="Filter by keyword or category"
              aria-label="Filter opportunities"
              className="h-8 w-[240px] max-w-full rounded border border-input bg-transparent pl-7 pr-2 text-[12.5px] text-foreground placeholder:text-meta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <select
            value={stage}
            onChange={(e) => changeStage((e.target.value as SeoStage) || "")}
            aria-label="Filter by stage"
            className="h-8 rounded border border-input bg-transparent px-2 text-[12.5px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">All stages</option>
            {BOARD_STAGES.map((s) => (
              <option key={s} value={s}>{STAGE_META[s].label}</option>
            ))}
          </select>
          {activeFilter && (
            <button type="button" onClick={() => { changeStage(""); changeQuery(""); }} className="inline-flex items-center gap-1 text-[12px] text-meta transition-colors hover:text-foreground">
              <X className="size-3.5" /> Clear
            </button>
          )}
          <span className="ml-auto text-[11.5px] text-meta">{filtered.length} of {opportunities.length}</span>
        </Toolbar>
      )}

      {noData ? (
        <EmptyState
          icon={<Search className="size-5" />}
          title="No opportunities yet"
          body="Run Discover to pull keyword ideas for Zoe's categories across the DMV, match them to the site, and queue them here for approval. Nothing is shown until real SERP data is read — no fabricated rows."
        />
      ) : view === "board" ? (
        <SeoBoard initial={opportunities} onOpen={setOpenId} />
      ) : noMatches ? (
        <EmptyState
          title="No opportunities match these filters"
          body="Zero matches for the current stage/search — not zero opportunity. Clear the filters to see the full pipeline."
          action={<button type="button" onClick={() => { changeStage(""); changeQuery(""); }} className="rounded border border-border px-3 py-1.5 text-[12.5px] text-foreground transition-colors hover:bg-row-hover">Clear filters</button>}
        />
      ) : (
        <div className="overflow-auto rounded border border-border">
          <table className={tableCls}>
            <thead className={theadCls}>
              <tr>
                <th className={`${thCls} w-[30%]`}>Keyword</th>
                <th className={thCls}>Category</th>
                <th className={thCls}>Intent</th>
                <th className={thCls}>Action</th>
                <th className={thCls}>Matched URL</th>
                <th className={`${thCls} text-right`}>Priority</th>
                <th className={thCls}>Stage</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((o) => (
                <tr key={o.id} className={`${rowCls} cursor-pointer`} onClick={() => setOpenId(o.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") setOpenId(o.id); }}>
                  <td className={`${tdCls} truncate font-medium text-foreground`} title={o.keyword}>{o.keyword}</td>
                  <td className={`${tdCls} text-secondary-text`}>{o.category ?? "—"}</td>
                  <td className={`${tdCls} text-secondary-text`}>{o.intent}</td>
                  <td className={tdCls}><ActionLabel action={o.recommendedAction} /></td>
                  <td className={`${tdCls} truncate text-meta`} title={o.matchedUrl ?? ""}>{o.matchedUrl ? o.matchedUrl.replace(/^https?:\/\/[^/]+/, "") || "/" : "—"}</td>
                  <td className={`${tdCls} text-right tabular-nums text-foreground`}>{o.priority ?? "—"}</td>
                  <td className={tdCls}><StatusBadge tone={stageTone(o.stage)} size="sm">{STAGE_META[o.stage]?.label ?? o.stage}</StatusBadge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openId && (
        <SidePanelOverlay onClose={() => setOpenId(null)}>
          <SeoOpportunityPanel id={openId} onClose={() => setOpenId(null)} />
        </SidePanelOverlay>
      )}
    </BladeMain>
  );
}
