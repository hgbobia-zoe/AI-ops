"use client";

// SEO Growth — Review Queue. The human go/no-go on finished drafts. Every draft awaiting review is listed with
// its quality summary; the reviewer opens it, reads the preview + findings, and approves or sends it back.
// Approval clears a draft to publish but never publishes it — publishing is a separate authorized step.

import { useState } from "react";
import Link from "next/link";
import { ClipboardCheck } from "lucide-react";
import { SidePanelOverlay } from "@/components/SidePanelOverlay";
import { SeoDraftPanel } from "@/components/seo/SeoDraftPanel";
import { BladeMain } from "@/components/ui/layouts";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status";
import { EmptyState } from "@/components/ui/states";
import { tableCls, theadCls, thCls, tdCls, rowCls } from "@/components/console-primitives";
import { qualityDisplay } from "@/lib/seo/display";
import type { StudioRow } from "@/lib/seo/produce";

export function SeoReviewQueue({ rows }: { rows: StudioRow[] }): React.JSX.Element {
  const [openDraftId, setOpenDraftId] = useState<string | null>(null);
  const empty = rows.length === 0;

  return (
    <BladeMain className="max-w-[1100px]">
      <PageHeader
        icon={<ClipboardCheck className="size-5" />}
        title="Review Queue"
        subtitle="Human go/no-go on finished drafts. Read the preview and the quality findings, then approve or request changes. Approval clears a draft to publish; publishing stays a separate authorized step."
      />

      {empty ? (
        <EmptyState
          icon={<ClipboardCheck className="size-5" />}
          title="Nothing awaiting review"
          body={<>Produce a draft in the <Link href="/seo/content" className="underline underline-offset-2">Content Studio</Link> and submit it for review; it will appear here.</>}
        />
      ) : (
        <div className="overflow-auto rounded border border-border">
          <table className={tableCls}>
            <thead className={theadCls}>
              <tr>
                <th className={`${thCls} w-[34%]`}>Keyword</th>
                <th className={thCls}>Slug</th>
                <th className={thCls}>Quality</th>
                <th className={`${thCls} text-right`}>To verify</th>
                <th className={`${thCls} text-right`}>Review</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const q = qualityDisplay(row.draft!.errors, row.draft!.warnings);
                return (
                  <tr key={row.draft!.id} className={`${rowCls} cursor-pointer`} onClick={() => setOpenDraftId(row.draft!.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") setOpenDraftId(row.draft!.id); }}>
                    <td className={`${tdCls} truncate font-medium text-foreground`} title={row.keyword}>{row.keyword}</td>
                    <td className={`${tdCls} truncate font-mono text-[11.5px] text-meta`}>{row.draft!.slug}</td>
                    <td className={tdCls}><StatusBadge tone={q.tone} size="sm">{q.label}</StatusBadge></td>
                    <td className={`${tdCls} text-right tabular-nums text-meta`}>{row.draft!.unsupportedClaims}</td>
                    <td className={`${tdCls} text-right`}><span className="rounded border border-border px-2.5 py-1 text-[12px] text-foreground">Open</span></td>
                  </tr>
                );
              })}
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
