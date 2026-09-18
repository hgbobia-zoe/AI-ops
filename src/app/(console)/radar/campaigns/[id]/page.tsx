// Opportunity Radar — campaign detail. Members + the derived funnel metrics for this campaign, and an
// auto-match control to pull in any newly-discovered opportunities matching its criteria.

import Link from "next/link";
import { notFound } from "next/navigation";
import { RadarTabs } from "@/components/RadarTabs";
import { CampaignAutoMatch } from "@/components/CampaignControls";
import { FigureStrip, type Figure } from "@/components/console-primitives";
import { SeedTag, ScorePill, TierBadge } from "@/components/radar-badges";
import { campaignDetail } from "@/lib/opportunity/campaigns";
import { KIND_LABEL, JURISDICTION_LABEL } from "@/lib/opportunity/types";
import { todayInOpsTz, formatYmdLong } from "@/lib/dates";

export const dynamic = "force-dynamic";

function fmtK(n: number): string { return n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`; }

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  const { id } = await params;
  const today = todayInOpsTz();
  const c = campaignDetail(id, today);
  if (!c) notFound();

  const figures: Figure[] = [
    { label: "Opportunities", value: c.opportunities },
    { label: "Qualified", value: c.qualified, tone: "positive" },
    { label: "Companies", value: c.companies },
    { label: "Outreach sent", value: c.outreachSent, sep: true },
    { label: "Contacted", value: c.contacted, tone: c.contacted ? "attention" : "default" },
    { label: "Won", value: c.won, tone: c.won ? "positive" : "default" },
  ];

  return (
    <main className="p-6">
      <div className="mb-4 text-[12px] text-meta"><Link href="/radar" className="hover:text-foreground">Opportunity Radar</Link> / <Link href="/radar/campaigns" className="hover:text-foreground">Campaigns</Link> / {c.campaign.name}</div>
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2"><h1 className="text-[22px] font-medium tracking-tight">{c.campaign.name}</h1>{c.campaign.isSeed && <SeedTag />}</div>
          {c.campaign.description && <p className="text-[12.5px] text-meta">{c.campaign.description}</p>}
        </div>
        <div className="flex items-center gap-3"><FigureStrip figures={figures} /><CampaignAutoMatch campaignId={c.campaign.id} /></div>
      </header>
      <RadarTabs />

      {c.members.length === 0 ? (
        <p className="text-[13px] text-meta">No opportunities in this campaign yet. Use auto-match to pull in matching opportunities.</p>
      ) : (
        <div className="border border-border">
          {c.members.map((v) => (
            <Link key={v.opp.id} href={`/radar/${v.opp.id}`} className="flex items-start gap-3 border-t border-[var(--row-rule)] px-3 py-2.5 transition-colors first:border-t-0 hover:bg-[var(--row-hover)]">
              <div className="w-10 shrink-0 text-center"><ScorePill score={v.score.opportunityScore} tier={v.score.tier} /><div className="text-[9.5px]"><TierBadge tier={v.score.tier} /></div></div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-foreground">{v.opp.name}</div>
                <div className="text-[12px] text-meta">{KIND_LABEL[v.opp.kind]} · {JURISDICTION_LABEL[v.opp.jurisdiction]}{v.opp.estimatedDate ? ` · ${formatYmdLong(v.opp.estimatedDate)}` : v.opp.deadline ? ` · due ${formatYmdLong(v.opp.deadline)}` : ""}</div>
                <div className="mt-0.5 text-[12px] text-tertiary-text">→ {v.recommendedAction}</div>
              </div>
              <div className="hidden shrink-0 text-right sm:block"><div className="text-[13px] tabular-nums text-foreground">{v.value ? fmtK(v.value.high) : "—"}</div></div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
