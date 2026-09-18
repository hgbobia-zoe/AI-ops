// Opportunity Radar — entity (company/contact) detail. Every opportunity this company touches and the
// role it plays, plus its existing Zoe relationship (§17) — so a rep sees the whole picture before
// approaching. Publicly-available business info only.

import Link from "next/link";
import { notFound } from "next/navigation";
import { RadarTabs } from "@/components/RadarTabs";
import { SeedTag, VerificationBadge, ScorePill, TierBadge } from "@/components/radar-badges";
import { getEntity, getOpportunitiesForEntity } from "@/lib/opportunity/store";
import { singleView } from "@/lib/opportunity/service";
import { buildCustomerIndex, matchEntity } from "@/lib/opportunity/relationship";
import { ENTITY_KIND_LABEL, RELATIONSHIP_LABEL, KIND_LABEL, JURISDICTION_LABEL, type EntityKind } from "@/lib/opportunity/types";
import { todayInOpsTz, formatYmdLong } from "@/lib/dates";

export const dynamic = "force-dynamic";

export default async function EntityDetailPage({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  const { id } = await params;
  const entity = getEntity(id);
  if (!entity) notFound();
  const today = todayInOpsTz();
  const links = getOpportunitiesForEntity(id);
  const memo = matchEntity({ name: entity.name, email: entity.email }, buildCustomerIndex(today));

  return (
    <main className="max-w-[1000px] p-6">
      <div className="mb-4 text-[12px] text-meta"><Link href="/radar" className="hover:text-foreground">Opportunity Radar</Link> / <Link href="/radar/companies" className="hover:text-foreground">Companies</Link> / {entity.name}</div>
      <header className="mb-5">
        <div className="mb-1 flex items-center gap-2">
          <h1 className="text-[22px] font-medium tracking-tight">{entity.name}</h1>
          {entity.isSeed && <SeedTag />}
          <VerificationBadge status={entity.verificationStatus} />
        </div>
        <p className="text-[13px] text-meta">{ENTITY_KIND_LABEL[entity.kind as EntityKind] ?? entity.kind}{entity.email ? ` · ${entity.email}` : ""}{entity.phone ? ` · ${entity.phone}` : ""}{entity.website ? ` · ${entity.website}` : ""}</p>
      </header>
      <RadarTabs />

      {memo.matched && memo.customer && (
        <section className="mb-5 rounded border border-attention/30 bg-attention/[0.05] p-3 text-[13px]">
          <span className="font-medium text-attention">Existing Zoe relationship.</span>{" "}
          {memo.customer.bookings} booking{memo.customer.bookings === 1 ? "" : "s"}
          {memo.customer.totalRevenue != null ? `, $${memo.customer.totalRevenue.toLocaleString()} won` : ""}
          {memo.customer.hasLostQuote ? ", has a lost quote" : ""}
          {memo.customer.daysSinceLast != null ? `, last event ${memo.customer.daysSinceLast < 0 ? "upcoming" : `${memo.customer.daysSinceLast}d ago`}` : ""}.
          <span className="text-tertiary-text"> Recommended: {memo.recommendedAction}.</span>
        </section>
      )}

      <h2 className="mb-1.5 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Opportunities · {links.length}</h2>
      {links.length === 0 ? (
        <p className="text-[13px] text-meta">Not linked to any opportunity.</p>
      ) : (
        <div className="border border-border">
          {links.map(({ opportunity: o, relationship, isPrimaryTarget }) => {
            const v = singleView(o.id, today);
            return (
              <Link key={o.id} href={`/radar/${o.id}`} className="flex items-start gap-3 border-t border-[var(--row-rule)] px-3 py-2.5 transition-colors first:border-t-0 hover:bg-[var(--row-hover)]">
                {v && <div className="w-10 shrink-0 text-center"><ScorePill score={v.score.opportunityScore} tier={v.score.tier} /><div className="text-[9.5px]"><TierBadge tier={v.score.tier} /></div></div>}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-foreground">{o.name}</div>
                  <div className="text-[12px] text-meta">{KIND_LABEL[o.kind]} · {JURISDICTION_LABEL[o.jurisdiction]}{o.estimatedDate ? ` · ${formatYmdLong(o.estimatedDate)}` : o.deadline ? ` · due ${formatYmdLong(o.deadline)}` : ""}</div>
                </div>
                <div className="shrink-0 text-right">
                  <span className="rounded border border-border px-1.5 py-px text-[10.5px] uppercase tracking-[0.04em] text-tertiary-text">{RELATIONSHIP_LABEL[relationship]}</span>
                  {isPrimaryTarget && <div className="mt-0.5 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-positive">Primary target</div>}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}
