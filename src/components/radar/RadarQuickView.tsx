"use client";

// The Radar board's quick view: an opportunity opened in the shared side panel (SidePanelOverlay, the
// same overlay the Sales OS board uses) over the board, instead of a full page hop. The open card lives
// in the URL (?open=<id>), so closing swaps back to the board URL without scrolling it.

import Link from "next/link";
import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { X, Maximize2 } from "lucide-react";
import { SidePanelOverlay } from "@/components/SidePanelOverlay";

export function RadarQuickView({ id, closeHref, children }: { id: string; closeHref: string; children: React.ReactNode }): React.JSX.Element {
  const router = useRouter();
  const close = useCallback(() => router.replace(closeHref, { scroll: false }), [router, closeHref]);
  return (
    <SidePanelOverlay onClose={close} widthClass="max-w-[46rem]">
      <div className="flex h-full flex-col border-l border-border bg-background" role="dialog" aria-modal="true" aria-label="Opportunity quick view">
        <div className="flex shrink-0 items-center justify-end gap-1 border-b border-border px-3 py-2">
          <Link href={`/radar/${id}`} className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-[12px] text-meta transition-colors hover:bg-row-hover hover:text-foreground">
            <Maximize2 className="size-3.5" /> Full page
          </Link>
          <button type="button" onClick={close} aria-label="Close" className="rounded p-1 text-meta transition-colors hover:bg-row-hover hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </SidePanelOverlay>
  );
}
