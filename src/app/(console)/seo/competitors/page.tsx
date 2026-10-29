// SEO Growth — Competitors. Who ranks for Zoe's tracked keywords, and the specific gaps where competitors own
// page 1 and Zoe does not. FACTS ONLY: everything here is rolled up from OBSERVED Google SERP reads (the office
// runner) — appearances + mean rank per domain, and the deterministic gap findings. Nothing is estimated. An
// empty state is honest (no SERPs read yet), never a fabricated table.

import Link from "next/link";
import { Building2, ArrowUpRight, Info } from "lucide-react";
import { getSettings } from "@/lib/settings";
import { competitorDomainAggregate } from "@/lib/seo/store";
import { seoFindings } from "@/lib/seo/findings";

export const dynamic = "force-dynamic";

export default function SeoCompetitorsPage(): React.JSX.Element {
  const zoeDomain = getSettings().seoZoeDomain;
  const domains = competitorDomainAggregate(zoeDomain);
  const gaps = seoFindings({ actionableOnly: true }).filter((f) => f.kind === "gap").slice(0, 12);

  return (
    <main className="max-w-[1100px] p-6">
      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight">
          <Building2 className="size-5 text-meta" /> Competitors
        </h1>
        <p className="mt-1 text-[13px] text-meta">
          Which rental companies rank for Zoe&apos;s keywords, and where the gaps are. Rolled up from live Google SERP reads; Zoe ({zoeDomain}) and directories (Yelp, The Knot, etc.) are excluded.
        </p>
      </header>

      {domains.length === 0 ? (
        <div className="flex items-start gap-2 rounded border border-border bg-[var(--row-hover)] px-3 py-2.5 text-[12.5px] text-tertiary-text">
          <Info className="mt-0.5 size-3.5 shrink-0 text-meta" />
          <span>
            No SERP reads yet. Set the Zoe + competitor domains in <Link href="/admin" className="underline">Settings</Link>, then run the office runner (tools/seo-runner). Competitor rankings appear here once it reads.
          </span>
        </div>
      ) : (
        <section className="mb-6">
          <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Who ranks against Zoe</h2>
          <div className="overflow-x-auto rounded border border-border">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[0.06em] text-meta">
                  <th className="px-3 py-2 font-medium">Domain</th>
                  <th className="px-3 py-2 text-right font-medium">Keywords ranked</th>
                  <th className="px-3 py-2 text-right font-medium">Avg position</th>
                  <th className="px-3 py-2 font-medium">Examples</th>
                </tr>
              </thead>
              <tbody>
                {domains.map((d) => (
                  <tr key={d.domain} className="border-t border-[var(--row-rule)]">
                    <td className="px-3 py-2 font-medium text-foreground">{d.domain}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-foreground">{d.appearances}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-foreground">#{d.avgRank}</td>
                    <td className="px-3 py-2 text-meta">{d.keywords.slice(0, 3).join(", ")}{d.keywords.length > 3 ? ` +${d.keywords.length - 3}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {gaps.length > 0 && (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Top gaps — competitors rank, Zoe does not</h2>
            <Link href="/seo/opportunities" className="inline-flex items-center gap-1 text-[12px] text-meta transition-colors hover:text-foreground">
              All opportunities <ArrowUpRight className="size-3.5" />
            </Link>
          </div>
          <div className="rounded border border-border">
            {gaps.map((f) => (
              <Link
                key={f.opportunityId}
                href="/seo/opportunities"
                className="flex items-start gap-3 border-t border-[var(--row-rule)] px-3 py-2.5 transition-colors first:border-t-0 hover:bg-[var(--row-hover)]"
              >
                <span className="mt-0.5 shrink-0 rounded bg-critical/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.06em] text-critical">Gap</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-medium text-foreground">{f.keyword}</div>
                  <div className="truncate text-[12px] text-meta">{f.detail}</div>
                </div>
                {f.priority != null && <span className="shrink-0 tabular-nums text-[11px] text-meta">P{f.priority}</span>}
              </Link>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
