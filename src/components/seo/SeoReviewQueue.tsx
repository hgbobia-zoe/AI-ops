"use client";

// SEO Review Queue — the human go/no-go on finished drafts. Every draft awaiting review is listed with its
// quality summary; the reviewer opens it, reads the preview + findings, and approves or sends it back. Approval
// clears a draft to publish but never publishes it — publishing is a separate authorized step.

import { useState } from "react";
import Link from "next/link";
import { ClipboardCheck, ArrowLeft } from "lucide-react";
import { SidePanelOverlay } from "@/components/SidePanelOverlay";
import { SeoDraftPanel } from "@/components/seo/SeoDraftPanel";
import { tableCls, theadCls, thCls, tdCls, rowCls } from "@/components/console-primitives";
import type { StudioRow } from "@/lib/seo/produce";

export function SeoReviewQueue({ rows }: { rows: StudioRow[] }): React.JSX.Element {
  const [openDraftId, setOpenDraftId] = useState<string | null>(null);
  const empty = rows.length === 0;

  return (
    <main className="max-w-[1100px] p-6">
      <Link href="/seo" className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-meta transition-colors hover:text-foreground"><ArrowLeft className="size-3.5" /> SEO Growth</Link>
      <header className="mb-4">
        <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight"><ClipboardCheck className="size-5 text-meta" /> Review Queue</h1>
        <p className="mt-1 text-[13px] text-meta">Human go/no-go on finished drafts. Read the preview and the quality findings, then approve or request changes. Approval clears a draft to publish; publishing stays a separate authorized step.</p>
      </header>

      {empty ? (
        <div className="rounded border border-dashed border-border p-6 text-center">
          <p className="text-[13px] text-tertiary-text">Nothing awaiting review.</p>
          <p className="mx-auto mt-1 max-w-md text-[12px] text-meta">Produce a draft in the <Link href="/seo/content" className="underline">Content Studio</Link> and submit it for review; it will appear here.</p>
        </div>
      ) : (
        <div className="overflow-auto rounded border border-border">
          <table className={tableCls}>
            <thead className={theadCls}>
              <tr>
                <th className={`${thCls} w-[34%]`}>Keyword</th>
                <th className={thCls}>Slug</th>
                <th className={thCls}>Quality</th>
                <th className={thCls}>To verify</th>
                <th className={`${thCls} text-right`}>Review</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.draft!.id} className={`${rowCls} cursor-pointer`} onClick={() => setOpenDraftId(row.draft!.id)}>
                  <td className={`${tdCls} truncate font-medium text-foreground`} title={row.keyword}>{row.keyword}</td>
                  <td className={`${tdCls} truncate font-mono text-[11.5px] text-meta`}>{row.draft!.slug}</td>
                  <td className={tdCls}>{row.draft!.errors > 0 ? <span className="text-critical">{row.draft!.errors} error(s)</span> : row.draft!.warnings > 0 ? <span className="text-attention">{row.draft!.warnings} warning(s)</span> : <span className="text-[color:var(--positive,#16a34a)]">Passed</span>}</td>
                  <td className={`${tdCls} tabular-nums text-meta`}>{row.draft!.unsupportedClaims}</td>
                  <td className={`${tdCls} text-right`}><span className="rounded border border-border px-2.5 py-1 text-[12px] text-foreground">Open</span></td>
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
