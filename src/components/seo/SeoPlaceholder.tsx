// Honest placeholder for an SEO Growth sub-section that lands in a later phase. A REAL route with a
// truthful "coming later" state — never a fake dashboard. Server component.

import Link from "next/link";
import { ArrowLeft, type LucideIcon } from "lucide-react";

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
    <main className="max-w-[800px] p-6">
      <Link href="/seo" className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-meta transition-colors hover:text-foreground">
        <ArrowLeft className="size-3.5" /> SEO Growth
      </Link>
      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight">
          <Icon className="size-5 text-meta" /> {title}
        </h1>
        <p className="mt-1 text-[13px] text-meta">{summary}</p>
      </header>

      <div className="rounded border border-dashed border-border p-5">
        <div className="inline-flex items-center rounded border border-border px-2 py-0.5 text-[11px] uppercase tracking-[0.08em] text-meta">{phase}</div>
        <p className="mt-3 text-[13px] text-tertiary-text">This section is not built yet. When it ships it will:</p>
        <ul className="mt-2 space-y-1.5">
          {points.map((p) => (
            <li key={p} className="flex gap-2 text-[13px] text-secondary-text">
              <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-[var(--bar)]" />
              <span>{p}</span>
            </li>
          ))}
        </ul>
        <p className="mt-4 border-t border-[var(--row-rule)] pt-3 text-[12px] text-meta">
          No data is shown here because none is produced yet. Nothing on this screen is fabricated.
        </p>
      </div>
    </main>
  );
}
