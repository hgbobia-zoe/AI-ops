// Opportunity Radar — campaigns (§11). Group opportunities into named campaigns with target criteria
// and measure signal → outreach → revenue per campaign.

import Link from "next/link";
import { RadarTabs } from "@/components/RadarTabs";
import { CampaignCreate } from "@/components/CampaignControls";
import { tableCls, theadCls, thCls } from "@/components/console-primitives";
import { SeedTag } from "@/components/radar-badges";
import { listCampaignMetrics } from "@/lib/opportunity/campaigns";
import { seedOpportunitiesIfEmpty, refreshOpportunities } from "@/lib/opportunity/seed";
import { seedRadarIfEmpty } from "@/lib/radar/seed";

export const dynamic = "force-dynamic";

function fmtK(n: number): string { return n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`; }

export default async function CampaignsPage(): Promise<React.JSX.Element> {
  try { await seedRadarIfEmpty(); } catch { /* ignore */ }
  try { await seedOpportunitiesIfEmpty(); } catch { /* ignore */ }
  try { await refreshOpportunities(); } catch { /* ignore */ }

  const campaigns = listCampaignMetrics();

  return (
    <main className="p-6">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-[22px] font-medium tracking-tight">Opportunity Radar</h1><p className="text-[12.5px] text-meta">Campaigns — group opportunities and track signal → outreach → revenue.</p></div>
        <CampaignCreate />
      </header>
      <RadarTabs />

      {campaigns.length === 0 ? (
        <p className="text-[13px] text-meta">No campaigns yet. Create one with target criteria (type, jurisdiction, min score) and it auto-populates from matching opportunities.</p>
      ) : (
        <div className="overflow-x-auto border border-border">
          <table className={tableCls}>
            <colgroup><col /><col style={{ width: "80px" }} /><col style={{ width: "90px" }} /><col style={{ width: "90px" }} /><col style={{ width: "90px" }} /><col style={{ width: "110px" }} /></colgroup>
            <thead className={theadCls}><tr><th className={thCls}>Campaign</th><th className={`${thCls} text-right`}>Opps</th><th className={`${thCls} text-right`}>Companies</th><th className={`${thCls} text-right`}>Contacted</th><th className={`${thCls} text-right`}>Conv.</th><th className={`${thCls} text-right`}>Indic. value</th></tr></thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.campaign.id} className="border-t border-[var(--row-rule)] transition-colors hover:bg-[var(--row-hover)]">
                  <td className="px-2.5 py-2.5"><Link href={`/radar/campaigns/${c.campaign.id}`} className="flex items-center gap-2"><span className="font-medium text-foreground hover:underline">{c.campaign.name}</span>{c.campaign.isSeed && <SeedTag />}</Link></td>
                  <td className="px-2.5 py-2.5 text-right tabular-nums">{c.opportunities}</td>
                  <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{c.companies}</td>
                  <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{c.contacted}</td>
                  <td className="px-2.5 py-2.5 text-right tabular-nums text-meta">{c.conversionRate != null ? `${Math.round(c.conversionRate * 100)}%` : "—"}</td>
                  <td className="px-2.5 py-2.5 text-right tabular-nums text-meta">{c.indicativeValueHigh ? fmtK(c.indicativeValueHigh) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
