// Honest placeholder for an SEO Growth sub-section that lands in a later phase. A REAL route with a
// truthful "coming later" state — never a fake dashboard. Server component, on the shared Nocturne primitives.

import Link from "next/link";
import { ArrowLeft, type LucideIcon } from "lucide-react";
import { BladeMain } from "@/components/ui/layouts";
import { PageHeader } from "@/components/ui/page-header";
import { Surface } from "@/components/ui/surface";

export function SeoPlaceholder({
  title,
  icon: Icon,
  phase,
  summary,
  points,
}: {
  title: string;
  icon: LucideIcon;
  phase: string;
  summary: string;
  points: string[];
}): React.JSX.Element {
  return (
    <BladeMain className="max-w-[820px]">
      <Link href="/seo" className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-meta transition-colors hover:text-foreground">
        <ArrowLeft className="size-3.5" /> SEO Growth
      </Link>
      <PageHeader icon={<Icon className="size-5" />} title={title} subtitle={summary} />

      <Surface pad="lg" className="border-dashed">
        <div className="inline-flex items-center rounded border border-border px-2 py-0.5 text-[11px] uppercase tracking-[0.08em] text-meta">{phase}</div>
        <p className="mt-3 text-[13px] text-tertiary-text">This section is not built yet. When it ships it will:</p>
        <ul className="mt-2 space-y-1.5">
          {points.map((p) => (
            <li key={p} className="flex gap-2 text-[13px] text-secondary-text">
              <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-bar" />
              <span>{p}</span>
            </li>
          ))}
        </ul>
        <p className="mt-4 border-t border-rule pt-3 text-[12px] text-meta">
          No data is shown here because none is produced yet. Nothing on this screen is fabricated.
        </p>
      </Surface>
    </BladeMain>
  );
}
