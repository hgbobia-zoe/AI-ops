// SEO Growth — Competitors. Who ranks for Zoe's tracked keywords, and the specific gaps where competitors own
// page 1 and Zoe does not. FACTS ONLY: everything here is rolled up from OBSERVED Google SERP reads (the office
// runner) — appearances + mean rank per domain, and the deterministic gap findings. Nothing is estimated. An
// empty state is honest (no SERPs read yet), never a fabricated table.

import Link from "next/link";
import { Building2, ArrowUpRight } from "lucide-react";
import { getSettings } from "@/lib/settings";
import { competitorDomainAggregate } from "@/lib/seo/store";
import { seoFindings } from "@/lib/seo/findings";
import { BladeMain } from "@/components/ui/layouts";
import { PageHeader } from "@/components/ui/page-header";
import { Surface } from "@/components/ui/surface";
import { StatusBadge } from "@/components/ui/status";
import { StatusBanner } from "@/components/ui/states";
import { findingDisplay } from "@/lib/seo/display";
import { compactTableFrameCls, compactTableCls, compactTheadRowCls, compactThCls, compactTdCls, compactRowCls } from "@/components/console-primitives";

export const dynamic = "force-dynamic";

export default function SeoCompetitorsPage(): React.JSX.Element {
  const zoeDomain = getSettings().seoZoeDomain;
  const domains = competitorDomainAggregate(zoeDomain);
  const gaps = seoFindings({ actionableOnly: true }).filter((f) => f.kind === "gap").slice(0, 12);

  return (
    <BladeMain className="max-w-[1100px]">
      <PageHeader
        icon={<Building2 className="size-5" />}
        title="Competitors"
        subtitle={`Which rental companies rank for Zoe's keywords, and where the gaps are. Rolled up from live Google SERP reads; Zoe (${zoeDomain}) and directories (Yelp, The Knot, etc.) are excluded.`}
      />

      {domains.length === 0 ? (
        <StatusBanner tone="neutral" title="No SERP reads yet">
          Set the Zoe + competitor domains in <Link href="/admin" className="underline underline-offset-2">Settings</Link>, then run the
          Google SERP office runner. Competitor rankings appear here once it reads — nothing is estimated.
        </StatusBanner>
      ) : (
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-[13px] font-semibold text-foreground">Who ranks against Zoe</h2>
            <span className="text-[11.5px] text-meta">{domains.length} competitor domain{domains.length === 1 ? "" : "s"} observed</span>
          </div>
          <div className={compactTableFrameCls}>
            <table className={`${compactTableCls} min-w-[560px]`}>
              <thead>
                <tr className={compactTheadRowCls}>
                  <th className={compactThCls}>Domain</th>
                  <th className={`${compactThCls} text-right`}>Keywords ranked</th>
                  <th className={`${compactThCls} text-right`}>Avg position</th>
                  <th className={compactThCls}>Examples</th>
                </tr>
              </thead>
              <tbody>
                {domains.map((d) => (
                  <tr key={d.domain} className={compactRowCls}>
                    <td className={`${compactThCls} font-medium text-foreground`}>{d.domain}</td>
                    <td className={`${compactTdCls} text-right tabular-nums text-foreground`}>{d.appearances}</td>
                    <td className={`${compactTdCls} text-right tabular-nums text-foreground`}>#{d.avgRank}</td>
                    <td className={compactTdCls}>{d.keywords.slice(0, 3).join(", ")}{d.keywords.length > 3 ? ` +${d.keywords.length - 3}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {gaps.length > 0 && (
        <section className="mt-6 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-[13px] font-semibold text-foreground">Top gaps — competitors rank, Zoe does not</h2>
            <Link href="/seo/opportunities" className="inline-flex items-center gap-1 text-[12px] text-meta transition-colors hover:text-foreground">
              All opportunities <ArrowUpRight className="size-3.5" />
            </Link>
          </div>
          <Surface pad="none" className="divide-y divide-[color:var(--row-rule)]">
            {gaps.map((f) => {
              const fd = findingDisplay(f.kind);
              return (
                <Link key={f.opportunityId} href="/seo/opportunities" className="flex items-start gap-3 px-3 py-2.5 transition-colors hover:bg-row-hover">
                  <span className="mt-0.5 w-[72px] shrink-0"><StatusBadge tone={fd.tone} size="sm">{fd.label}</StatusBadge></span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] font-medium text-foreground">{f.keyword}</div>
                    <div className="truncate text-[12px] text-meta">{f.detail}</div>
                  </div>
                  {f.priority != null && <span className="shrink-0 tabular-nums text-[11px] text-meta">P{f.priority}</span>}
                </Link>
              );
            })}
          </Surface>
        </section>
      )}
    </BladeMain>
  );
}
