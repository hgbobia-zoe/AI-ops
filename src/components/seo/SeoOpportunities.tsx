"use client";

// SEO Growth — Opportunities. A list/table with a board-view toggle; each opportunity opens in the shared
// side panel for the evidence, recommendation, priority breakdown and the opportunity-approval decision.
// A "Discover" action (owner/admin) runs the pull. HONEST empty state: with no Ubersuggest credential nothing
// is discovered and we say so, never faking rows.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search, LayoutGrid, Table as TableIcon, Loader2, Sparkles, Info } from "lucide-react";
import { SidePanelOverlay } from "@/components/SidePanelOverlay";
import { SeoOpportunityPanel } from "@/components/seo/SeoOpportunityPanel";
import { SeoBoard } from "@/components/seo/SeoBoard";
import { tableCls, theadCls, thCls, tdCls, rowCls } from "@/components/console-primitives";
import { STAGE_META } from "@/lib/seo/stages";
import type { SeoHealth, SeoOpportunity } from "@/lib/seo/types";

const ACTION_TONE: Record<string, string> = {
  CREATE: "text-[color:var(--positive,#16a34a)]",
  IMPROVE: "text-attention",
  CONSOLIDATE: "text-foreground",
  SKIP: "text-meta",
};

function priorityTone(n: number | null): string {
  if (n == null) return "text-meta";
  if (n >= 70) return "text-critical";
  if (n >= 40) return "text-attention";
  return "text-meta";
}

export function SeoOpportunities({ opportunities, health }: { opportunities: SeoOpportunity[]; health: SeoHealth }): React.JSX.Element {
  const router = useRouter();
  const [view, setView] = useState<"table" | "board">("table");
  const [openId, setOpenId] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

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

  const empty = opportunities.length === 0;

  return (
    <main className="max-w-[1200px] p-6">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight">
            <Search className="size-5 text-meta" /> Opportunities
          </h1>
          <p className="mt-1 text-[13px] text-meta">Keyword opportunities matched against Zoe&apos;s site, each with a recommended action, an explainable priority, and the first approval gate.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded border border-border p-0.5">
            <button onClick={() => setView("table")} className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[12px] ${view === "table" ? "bg-[var(--row-hover)] text-foreground" : "text-meta"}`}>
              <TableIcon className="size-3.5" /> Table
            </button>
            <button onClick={() => setView("board")} className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[12px] ${view === "board" ? "bg-[var(--row-hover)] text-foreground" : "text-meta"}`}>
              <LayoutGrid className="size-3.5" /> Board
            </button>
          </div>
          <button onClick={() => void discover()} disabled={discovering} className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-foreground transition-colors hover:bg-[var(--row-hover)] disabled:opacity-50">
            {discovering ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} Discover
          </button>
        </div>
      </header>

      {msg && <div className="mb-3 flex items-start gap-2 rounded border border-border bg-[var(--row-hover)] px-3 py-2 text-[12.5px] text-tertiary-text"><Info className="mt-0.5 size-3.5 shrink-0 text-meta" />{msg}</div>}

      {!health.configured && (
        <div className="mb-3 flex items-start gap-2 rounded border border-border bg-[var(--row-hover)] px-3 py-2.5 text-[12.5px] text-tertiary-text">
          <Info className="mt-0.5 size-3.5 shrink-0 text-meta" />
          <span>Ubersuggest is not connected, so Discover will not return keyword data yet. Set the credential in <a href="/admin" className="underline">Settings</a>. The pipeline is live and will populate once connected.</span>
        </div>
      )}

      {empty ? (
        <div className="rounded border border-dashed border-border p-6 text-center">
          <p className="text-[13px] text-tertiary-text">No opportunities yet.</p>
          <p className="mx-auto mt-1 max-w-md text-[12px] text-meta">Run Discover to pull keyword ideas for Zoe&apos;s categories across the DMV, match them to the site, and queue them here for approval. Nothing is shown until real data is pulled — no fabricated rows.</p>
        </div>
      ) : view === "board" ? (
        <SeoBoard initial={opportunities} onOpen={setOpenId} />
      ) : (
        <div className="overflow-auto rounded border border-border">
          <table className={tableCls}>
            <thead className={theadCls}>
              <tr>
                <th className={`${thCls} w-[32%]`}>Keyword</th>
                <th className={thCls}>Category</th>
                <th className={thCls}>Intent</th>
                <th className={thCls}>Action</th>
                <th className={thCls}>Matched URL</th>
                <th className={`${thCls} text-right`}>Priority</th>
                <th className={thCls}>Stage</th>
              </tr>
            </thead>
            <tbody>
              {opportunities.map((o) => (
                <tr key={o.id} className={`${rowCls} cursor-pointer`} onClick={() => setOpenId(o.id)}>
                  <td className={`${tdCls} truncate font-medium text-foreground`} title={o.keyword}>{o.keyword}</td>
                  <td className={`${tdCls} text-secondary-text`}>{o.category ?? "—"}</td>
                  <td className={`${tdCls} text-secondary-text`}>{o.intent}</td>
                  <td className={tdCls}><span className={ACTION_TONE[o.recommendedAction ?? ""] ?? "text-meta"}>{o.recommendedAction ?? "—"}</span></td>
                  <td className={`${tdCls} truncate text-meta`} title={o.matchedUrl ?? ""}>{o.matchedUrl ? o.matchedUrl.replace(/^https?:\/\/[^/]+/, "") || "/" : "—"}</td>
                  <td className={`${tdCls} text-right tabular-nums ${priorityTone(o.priority)}`}>{o.priority ?? "—"}</td>
                  <td className={`${tdCls} text-secondary-text`}>{STAGE_META[o.stage]?.label ?? o.stage}</td>
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
    </main>
  );
}
