// AI Operations Manager (MVP7) — the command center. One ranked "what needs attention" feed
// synthesized from every blade (risk, sales, finance, customer). Deterministic: every item links
// back to the blade that owns it, and the brief is built from real counts — nothing invented.
//
// This blade is read-only synthesis: the acknowledgment/resolution workflow lives on /risk (each
// item offers a focused destination to it). Ranking logic lives in @/lib/ops/manager (unchanged).

import { Suspense } from "react";
import { Radar } from "lucide-react";
import { opsOverview } from "@/lib/ops/service";
import { summarize, opsBrief, type AttentionItem, type Priority, type DateBucket } from "@/lib/ops/manager";
import { formatYmdLong, DISPLAY_TZ } from "@/lib/dates";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";
import { PageHeader } from "@/components/ui/page-header";
import { BladeMain, OverviewLayout } from "@/components/ui/layouts";
import { Surface } from "@/components/ui/surface";
import { StatusBadge } from "@/components/ui/status";
import { OpsQueue } from "./OpsQueue";

export const dynamic = "force-dynamic";

const PRIORITIES: Priority[] = ["critical", "high", "medium", "info"];
const DATE_BUCKETS: DateBucket[] = ["all", "overdue", "today", "soon", "week", "later", "undated"];

/** Part-of-day in the operating timezone, so the heading is never a stale "This morning" at night. */
function partOfDay(): "morning" | "afternoon" | "evening" {
  const hour =
    Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: DISPLAY_TZ }).format(new Date())) % 24;
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

export default async function OpsPage({
  searchParams,
}: {
  searchParams: Promise<{ p?: string; d?: string; o?: string }>;
}): Promise<React.JSX.Element> {
  const showMoney = canSeeFinancials(await viewerRole());
  const full = await opsOverview();
  // Members don't see $ — drop finance-sourced items and recompute the brief/summary from the rest.
  const items: AttentionItem[] = showMoney ? full.items : full.items.filter((i) => i.source !== "finance");
  const summary = showMoney ? full.summary : summarize(items);
  const brief = showMoney ? full.brief : opsBrief(items, summary);

  const sp = await searchParams;
  const initialPriority: Priority | null = PRIORITIES.includes(sp.p as Priority) ? (sp.p as Priority) : null;
  const initialDate: DateBucket | null = DATE_BUCKETS.includes(sp.d as DateBucket) ? (sp.d as DateBucket) : null;
  const initialOwner: string | null = sp.o && sp.o.trim() ? sp.o : null;

  const today = full.today;

  const context = (
    <>
      <Surface pad="md" className="space-y-3">
        <div className="text-[11px] uppercase tracking-[0.07em] text-meta">Sources &amp; freshness</div>
        <div className="space-y-2 text-[12px]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-secondary-text">Labor (Connecteam)</span>
            {full.laborVerified ? (
              <StatusBadge tone="positive" size="sm">Live</StatusBadge>
            ) : (
              <StatusBadge tone="neutral" size="sm">Unavailable</StatusBadge>
            )}
          </div>
          {!full.laborVerified && (
            <p className="text-[11.5px] text-meta">
              Connecteam is unreachable, so labor signals are excluded — not assumed.
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-secondary-text">Event revenue (Goodshuffle)</span>
            <StatusBadge tone="neutral" size="sm">Pending</StatusBadge>
          </div>
          <p className="text-[11.5px] text-meta">
            Revenue-based signals appear once Goodshuffle revenue capture lands. Risk ranking already
            weights booking value where known.
          </p>
        </div>
      </Surface>

      <Surface pad="md" className="space-y-1.5">
        <div className="text-[11px] uppercase tracking-[0.07em] text-meta">How this ranks</div>
        <p className="text-[11.5px] leading-relaxed text-meta">
          The Operations Manager only prioritizes signals the other blades compute — it never decides
          on its own. Severity, due date and workflow status are shown separately; the priority is a
          deterministic function of all three plus booking weight.
        </p>
      </Surface>
    </>
  );

  return (
    <BladeMain>
      <PageHeader
        title="Operations Manager"
        icon={<Radar className="size-6" />}
        subtitle={`${formatYmdLong(today)} · one prioritized view across every system`}
      />

      <Surface pad="md" className="mb-4">
        <div className="text-[11px] font-medium uppercase tracking-[0.07em] text-meta">
          Current priorities · as of this {partOfDay()}
        </div>
        <p className="mt-1 text-[14.5px] leading-relaxed text-foreground">{brief}</p>
      </Surface>

      <OverviewLayout
        main={
          <Suspense fallback={<div className="text-[12px] text-meta">Loading queue…</div>}>
            <OpsQueue
              items={items}
              initialPriority={initialPriority}
              initialDate={initialDate}
              initialOwner={initialOwner}
            />
          </Suspense>
        }
        context={context}
      />
    </BladeMain>
  );
}
