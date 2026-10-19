"use client";

// SEO Content Studio — produce + preview landing-page drafts for opportunities a human has APPROVED. Each
// approved opportunity gets a deterministic draft (facts + [NEEDS REVIEW] markers) that passes through the
// quality checks; the reviewer opens it, reads the preview, and submits it for review. NOTHING here publishes.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Loader2, Sparkles, Info, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { SidePanelOverlay } from "@/components/SidePanelOverlay";
import { SeoDraftPanel } from "@/components/seo/SeoDraftPanel";
import { tableCls, theadCls, thCls, tdCls, rowCls } from "@/components/console-primitives";
import type { StudioRow } from "@/lib/seo/produce";

function qualityBadge(row: StudioRow): React.JSX.Element {
  const d = row.draft;
  if (!d) return <span className="text-meta">No draft</span>;
  if (d.errors > 0) return <span className="text-critical">{d.errors} error(s)</span>;
  if (d.warnings > 0) return <span className="text-attention">{d.warnings} warning(s)</span>;
  return <span className="text-[color:var(--positive,#16a34a)]">Passed</span>;
}

export function SeoContentStudio({ rows }: { rows: StudioRow[] }): React.JSX.Element {
  const router = useRouter();
  const [openDraftId, setOpenDraftId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function produce(oppId: string): Promise<void> {
    setBusyId(oppId);
    setMsg(null);
    try {
      const r = await fetch(`/api/seo/opportunity/${oppId}/draft`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const data = (await r.json()) as { ok?: boolean; draft?: { id: string }; error?: string; note?: string };
      if (!r.ok || !data.draft) {
        setMsg(data.note ?? data.error ?? "Could not produce a draft.");
        return;
      }
      setOpenDraftId(data.draft.id);
      router.refresh();
    } catch {
      setMsg("Produce failed — network error.");
    } finally {
      setBusyId(null);
    }
  }

  const empty = rows.length === 0;

  return (
    <main className="max-w-[1100px] p-6">
      <Link href="/seo" className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-meta transition-colors hover:text-foreground"><ArrowLeft className="size-3.5" /> SEO Growth</Link>
      <header className="mb-4">
        <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight"><FileText className="size-5 text-meta" /> Content Studio</h1>
        <p className="mt-1 text-[13px] text-meta">Produce a structured landing-page draft for each approved opportunity. Drafts reuse Zoe&apos;s templates and only state verified facts; everything else is marked for human review. Nothing is published here.</p>
      </header>

      {msg && <div className="mb-3 flex items-start gap-2 rounded border border-border bg-[var(--row-hover)] px-3 py-2 text-[12.5px] text-tertiary-text"><Info className="mt-0.5 size-3.5 shrink-0 text-meta" />{msg}</div>}

      {empty ? (
        <div className="rounded border border-dashed border-border p-6 text-center">
          <p className="text-[13px] text-tertiary-text">No approved opportunities yet.</p>
          <p className="mx-auto mt-1 max-w-md text-[12px] text-meta">Approve an opportunity on the <Link href="/seo/opportunities" className="underline">Opportunities</Link> board first. Content production is gated behind that approval.</p>
        </div>
      ) : (
        <div className="overflow-auto rounded border border-border">
          <table className={tableCls}>
            <thead className={theadCls}>
              <tr>
                <th className={`${thCls} w-[30%]`}>Keyword</th>
                <th className={thCls}>Action</th>
                <th className={thCls}>Draft</th>
                <th className={thCls}>Quality</th>
                <th className={thCls}>To verify</th>
                <th className={`${thCls} text-right`}>Produce / open</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className={rowCls}>
                  <td className={`${tdCls} truncate font-medium text-foreground`} title={row.keyword}>{row.keyword}</td>
                  <td className={`${tdCls} text-secondary-text`}>{row.action ?? "—"}</td>
                  <td className={`${tdCls} text-secondary-text`}>{row.draft ? row.draft.reviewState.replace("_", " ") : "—"}</td>
                  <td className={tdCls}>{qualityBadge(row)}</td>
                  <td className={`${tdCls} tabular-nums text-meta`}>{row.draft ? row.draft.unsupportedClaims : "—"}</td>
                  <td className={`${tdCls} text-right`}>
                    {row.draft ? (
                      <button onClick={() => setOpenDraftId(row.draft!.id)} className="rounded border border-border px-2.5 py-1 text-[12px] text-foreground transition-colors hover:bg-[var(--row-hover)]">Open</button>
                    ) : (
                      <button disabled={busyId === row.id} onClick={() => void produce(row.id)} className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[12px] text-foreground transition-colors hover:bg-[var(--row-hover)] disabled:opacity-50">
                        {busyId === row.id ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} Produce draft
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openDraftId && (
        <SidePanelOverlay onClose={() => setOpenDraftId(null)}>
          <SeoDraftPanel draftId={openDraftId} onClose={() => setOpenDraftId(null)} />
        </SidePanelOverlay>
      )}
    </main>
  );
}
