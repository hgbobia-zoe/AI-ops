// Opportunity Radar — companies / entities (§8). The relationship-graph nodes discovered across
// opportunities: agencies, primes, event managers, planners, vendors. Flags any that match Zoe's
// existing customer history (§17) so a rep re-engages instead of cold-contacting.

import Link from "next/link";
import { RadarTabs } from "@/components/RadarTabs";
import { tableCls, theadCls, thCls } from "@/components/console-primitives";
import { SeedTag, VerificationBadge } from "@/components/radar-badges";
import { getEntities, getEntityOpportunityCounts } from "@/lib/opportunity/store";
import { seedOpportunitiesIfEmpty, refreshOpportunities } from "@/lib/opportunity/seed";
import { seedRadarIfEmpty } from "@/lib/radar/seed";
import { ENTITY_KIND_LABEL, type EntityKind } from "@/lib/opportunity/types";

export const dynamic = "force-dynamic";

export default async function CompaniesPage(): Promise<React.JSX.Element> {
  try { await seedRadarIfEmpty(); } catch { /* ignore */ }
  try { await seedOpportunitiesIfEmpty(); } catch { /* ignore */ }
  try { await refreshOpportunities(); } catch { /* ignore */ }

  const entities = getEntities();
  const counts = getEntityOpportunityCounts();
  const withRelationship = entities.filter((e) => e.matchedCustomerKey).length;

  return (
    <main className="p-6">
      <header className="mb-4"><h1 className="text-[22px] font-medium tracking-tight">Opportunity Radar</h1><p className="text-[12.5px] text-meta">Companies &amp; contacts across all opportunities. {entities.length} total, {withRelationship} with an existing Zoe relationship.</p></header>
      <RadarTabs />

      <div className="overflow-x-auto border border-border">
        <table className={tableCls}>
          <colgroup><col /><col style={{ width: "170px" }} /><col style={{ width: "120px" }} /><col style={{ width: "90px" }} /><col style={{ width: "140px" }} /></colgroup>
          <thead className={theadCls}><tr><th className={thCls}>Company / contact</th><th className={thCls}>Type</th><th className={thCls}>Verification</th><th className={`${thCls} text-right`}>Opps</th><th className={thCls}>Zoe relationship</th></tr></thead>
          <tbody>
            {entities.map((e) => (
              <tr key={e.id} className="border-t border-[var(--row-rule)] transition-colors hover:bg-[var(--row-hover)]">
                <td className="px-2.5 py-2.5">
                  <Link href={`/radar/entities/${e.id}`} className="flex items-center gap-2">
                    <span className="font-medium text-foreground hover:underline">{e.name}</span>
                    {e.isSeed && <SeedTag />}
                  </Link>
                  {(e.email || e.phone) && <div className="text-[12px] text-meta">{[e.email, e.phone].filter(Boolean).join(" · ")}</div>}
                </td>
                <td className="px-2.5 py-2.5 text-[13px] text-tertiary-text">{ENTITY_KIND_LABEL[e.kind as EntityKind] ?? e.kind}</td>
                <td className="px-2.5 py-2.5"><VerificationBadge status={e.verificationStatus} /></td>
                <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{counts.get(e.id) ?? 0}</td>
                <td className="px-2.5 py-2.5 text-[12.5px]">{e.matchedCustomerKey ? <span className="text-attention">Existing customer</span> : <span className="text-meta">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
