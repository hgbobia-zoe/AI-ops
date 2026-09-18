// Opportunity Radar — source registry (§14). Every source the engine can pull from, its acquisition
// method (API / browser / manual), auth status, last run/failure, and record count. Adding a new
// procurement portal is a registry entry + an adapter — not a rewrite. Read-only in Phase 1.

import Link from "next/link";
import { getSourceRegistry } from "@/lib/opportunity/store";
import { seedOpportunitiesIfEmpty } from "@/lib/opportunity/seed";
import { tableCls, theadCls, thCls } from "@/components/console-primitives";
import { SeedTag } from "@/components/radar-badges";
import { BROWSER_WORKFLOWS } from "@/lib/opportunity/sources/browser";

export const dynamic = "force-dynamic";

const METHOD_TONE: Record<string, string> = { API: "text-positive", BROWSER: "text-attention", MANUAL: "text-meta" };
const AUTH_LABEL: Record<string, string> = { NONE: "—", REQUIRED_OK: "key set", REQUIRED_MISSING: "key missing" };
const AUTH_TONE: Record<string, string> = { REQUIRED_OK: "text-positive", REQUIRED_MISSING: "text-attention", NONE: "text-meta" };

export default async function SourcesPage(): Promise<React.JSX.Element> {
  try { await seedOpportunitiesIfEmpty(); } catch (e) { console.error("[opportunity] sources seed:", e); }
  const sources = getSourceRegistry();

  return (
    <main className="p-6">
      <div className="mb-4 text-[12px] text-meta"><Link href="/radar" className="hover:text-foreground">Opportunity Radar</Link> / Sources</div>
      <header className="mb-4">
        <h1 className="text-[22px] font-medium tracking-tight">Sources</h1>
        <p className="text-[12.5px] text-meta">Where Opportunity Radar pulls from. API sources call an official API; browser sources are fed by the local browser agent through a defined workflow; manual sources accept uploads. Each has its own adapter — add a portal without rewriting the engine.</p>
      </header>

      <div className="overflow-x-auto border border-border">
        <table className={tableCls}>
          <colgroup><col /><col style={{ width: "110px" }} /><col style={{ width: "120px" }} /><col style={{ width: "110px" }} /><col style={{ width: "130px" }} /><col style={{ width: "90px" }} /></colgroup>
          <thead className={theadCls}>
            <tr><th className={thCls}>Source</th><th className={thCls}>Method</th><th className={thCls}>Auth</th><th className={thCls}>Last run</th><th className={thCls}>Status</th><th className={`${thCls} text-right`}>Records</th></tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.id} className="border-t border-[var(--row-rule)]">
                <td className="px-2.5 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground">{s.name}</span>
                    {s.isSeed && <SeedTag />}
                    {!s.enabled && <span className="rounded border border-border px-1.5 py-px text-[10px] uppercase tracking-[0.06em] text-meta">disabled</span>}
                  </div>
                  <div className="text-[12px] text-meta">{s.kind}{s.url ? <> · <a href={s.url} target="_blank" rel="noopener noreferrer" className="hover:text-foreground">{s.url.replace(/^https?:\/\//, "")}</a></> : ""}{s.adapter ? "" : " · adapter not yet wired"}</div>
                </td>
                <td className="px-2.5 py-2.5"><span className={`text-[12px] font-medium uppercase tracking-[0.05em] ${METHOD_TONE[s.acquisitionMethod ?? ""] ?? "text-meta"}`}>{s.acquisitionMethod ?? "—"}</span></td>
                <td className="px-2.5 py-2.5"><span className={`text-[12.5px] ${AUTH_TONE[s.authStatus ?? "NONE"]}`}>{AUTH_LABEL[s.authStatus ?? "NONE"] ?? s.authStatus}</span></td>
                <td className="px-2.5 py-2.5 text-[12.5px] tabular-nums text-tertiary-text">{s.lastRunAt ? s.lastRunAt.slice(0, 10) : <span className="text-meta">never</span>}</td>
                <td className="px-2.5 py-2.5 text-[12.5px]"><span className={s.lastStatus === "OK" ? "text-positive" : s.lastStatus === "ERROR" ? "text-critical" : "text-meta"}>{s.lastStatus ?? "—"}</span></td>
                <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{s.recordsDiscovered ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="mt-6">
        <h2 className="mb-1.5 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Browser-agent workflows</h2>
        <p className="mb-2 text-[12px] text-meta">Defined per-source workflows the local browser agent runs (no blind crawling). The agent applies these search terms + geographic filters, extracts rows, and POSTs them to <code className="text-tertiary-text">/api/radar/ingest</code> (token-gated).</p>
        {BROWSER_WORKFLOWS.map((w) => (
          <div key={w.sourceId} className="mb-2 rounded border border-border p-3 text-[12.5px]">
            <div className="font-medium text-foreground">{w.name} <span className="text-[11px] text-meta">· parser v{w.parserVersion}</span></div>
            <div className="mt-1 text-meta">Search terms: <span className="text-tertiary-text">{w.searchTerms.join(", ")}</span></div>
            <div className="text-meta">Geographic filters: <span className="text-tertiary-text">{w.geoFilters.join(", ")}</span></div>
            <div className="mt-1 text-meta">{w.notes}</div>
          </div>
        ))}
      </section>
    </main>
  );
}
