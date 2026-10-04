// Exceptions — the Priority / Exception agent output: the buildAttention() ranked feed, P-labeled over
// the existing critical/high/medium/info scale (P0..P3 is a label mapping, not new severity logic). The
// final filter to the few signals that need an owner — fewer interruptions, not more. Owner/admin only.

import Link from "next/link";
import { redirect } from "next/navigation";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings, canSeeFinancials } from "@/lib/auth/roles";
import { aiOrg } from "@/lib/aiorg/service";
import { OrgTabs } from "@/components/aiorg/AiOrgBits";
import { FigureStrip, type Figure } from "@/components/console-primitives";

export const dynamic = "force-dynamic";

const P_TONE: Record<string, string> = { P0: "text-critical", P1: "text-attention", P2: "text-attention", P3: "text-meta" };
const P_BAR: Record<string, string> = { P0: "border-l-2 border-critical", P1: "border-l-2 border-attention", P2: "border-l-2 border-attention/60", P3: "border-l-2 border-transparent" };
const SOURCE_LABEL: Record<string, string> = { risk: "Risk", sales: "Sales", finance: "Finance", customer: "Customer" };

export default async function AiOrgExceptionsPage(): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canManageSettings(role)) redirect("/dashboard");
  const org = await aiOrg({ showMoney: canSeeFinancials(role) });

  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const x of org.exceptions) counts[x.pLabel]++;
  const figures: Figure[] = [
    { label: "P0", value: counts.P0, tone: counts.P0 ? "critical" : "default" },
    { label: "P1", value: counts.P1, tone: counts.P1 ? "attention" : "default" },
    { label: "P2", value: counts.P2 },
    { label: "P3", value: counts.P3 },
  ];

  return (
    <main className="max-w-[1000px] p-6">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-medium tracking-tight">Exceptions</h1>
          <p className="text-[12.5px] text-meta">{org.exceptions.length} signal{org.exceptions.length === 1 ? "" : "s"} after ranking and dedupe. P0/P1 are what need an owner now.</p>
        </div>
        <FigureStrip figures={figures} />
      </header>

      <OrgTabs active="/ai-org/exceptions" />

      {org.exceptions.length === 0 ? (
        <p className="border border-border px-3 py-3 text-[13px] text-positive">Nothing needs an owner right now. No active risks, booking gaps, or overruns after filtering.</p>
      ) : (
        <div className="border border-border">
          {org.exceptions.map((x) => (
            <Link key={x.key} href={x.href} className={`flex items-start gap-3 border-t border-[var(--row-rule)] px-3 py-3 transition-colors first:border-t-0 hover:bg-[var(--row-hover)] ${P_BAR[x.pLabel]}`}>
              <span className={`w-8 shrink-0 text-[12px] font-semibold tabular-nums ${P_TONE[x.pLabel]}`}>{x.pLabel}</span>
              <span className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium text-foreground">{x.title}</div>
                <div className="text-[12.5px] text-meta">{x.detail}</div>
              </span>
              <span className="shrink-0 text-[11px] uppercase tracking-[0.06em] text-meta">{SOURCE_LABEL[x.source] ?? x.source}</span>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
