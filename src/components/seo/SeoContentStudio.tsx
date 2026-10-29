"use client";

// SEO Content Studio — produce + preview landing-page drafts for opportunities a human has APPROVED. Each
// approved opportunity gets a deterministic draft (facts + [NEEDS REVIEW] markers) that passes through the
// quality checks; the reviewer opens it, reads the preview, and submits it for review. NOTHING here publishes.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Loader2, Sparkles } from "lucide-react";
import Link from "next/link";
import { SidePanelOverlay } from "@/components/SidePanelOverlay";
import { SeoDraftPanel } from "@/components/seo/SeoDraftPanel";
import { BladeMain } from "@/components/ui/layouts";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status";
import { StatusBanner, EmptyState } from "@/components/ui/states";
import { tableCls, theadCls, thCls, tdCls, rowCls } from "@/components/console-primitives";
import { qualityDisplay } from "@/lib/seo/display";
import type { StudioRow } from "@/lib/seo/produce";

function QualityCell({ row }: { row: StudioRow }): React.JSX.Element {
  const d = row.draft;
  if (!d) return <span className="text-meta">No draft</span>;
  const q = qualityDisplay(d.errors, d.warnings);
  return <StatusBadge tone={q.tone} size="sm">{q.label}</StatusBadge>;
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
    <BladeMain className="max-w-[1100px]">
      <PageHeader
        icon={<FileText className="size-5" />}
        title="Content Studio"
        subtitle="Produce a structured landing-page draft for each approved opportunity. Drafts reuse Zoe's templates and only state verified facts; everything else is marked for human review. Nothing is published here."
      />

      {msg && <StatusBanner tone="info" title="Content Studio" edge={false} className="mb-3">{msg}</StatusBanner>}

      {empty ? (
        <EmptyState
          icon={<FileText className="size-5" />}
          title="No approved opportunities yet"
          body={<>Approve an opportunity on the <Link href="/seo/opportunities" className="underline underline-offset-2">Opportunities</Link> board first. Content production is gated behind that approval.</>}
        />
      ) : (
        <div className="overflow-auto rounded border border-border">
          <table className={tableCls}>
            <thead className={theadCls}>
              <tr>
                <th className={`${thCls} w-[28%]`}>Keyword</th>
                <th className={thCls}>Action</th>
                <th className={thCls}>Draft</th>
                <th className={thCls}>Quality</th>
                <th className={`${thCls} text-right`}>To verify</th>
                <th className={`${thCls} text-right`}>Produce / open</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className={rowCls}>
                  <td className={`${tdCls} truncate font-medium text-foreground`} title={row.keyword}>{row.keyword}</td>
                  <td className={`${tdCls} text-secondary-text`}>{row.action ?? "—"}</td>
                  <td className={`${tdCls} text-secondary-text`}>{row.draft ? row.draft.reviewState.replace("_", " ") : "—"}</td>
                  <td className={tdCls}><QualityCell row={row} /></td>
                  <td className={`${tdCls} text-right tabular-nums text-meta`}>{row.draft ? row.draft.unsupportedClaims : "—"}</td>
                  <td className={`${tdCls} text-right`}>
                    {row.draft ? (
                      <button type="button" onClick={() => setOpenDraftId(row.draft!.id)} className="rounded border border-border px-2.5 py-1 text-[12px] text-foreground transition-colors hover:bg-row-hover">Open</button>
                    ) : (
                      <button type="button" disabled={busyId === row.id} onClick={() => void produce(row.id)} className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[12px] text-foreground transition-colors hover:bg-row-hover disabled:opacity-50">
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
    </BladeMain>
  );
}
