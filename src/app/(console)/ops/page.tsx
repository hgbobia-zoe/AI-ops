// AI Operations Manager (MVP7) — the command center. One ranked "what needs attention" feed
// synthesized from every blade (risk, sales, finance, customer). Deterministic: every item links
// back to the blade that owns it, and the brief is built from real counts — nothing invented.

import Link from "next/link";
import { Radar, ShieldAlert, TrendingUp, DollarSign, UserRound, ArrowRight, CheckCircle2 } from "lucide-react";
import { opsOverview } from "@/lib/ops/service";
import { summarize, opsBrief, type AttentionItem, type Priority } from "@/lib/ops/manager";
import { formatYmdLong } from "@/lib/dates";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

const PRIORITY_STYLE: Record<Priority, { chip: string; border: string; label: string }> = {
  critical: { chip: "border-red-500/50 bg-red-500/10 text-red-300", border: "border-l-red-500", label: "Critical" },
  high: { chip: "border-orange-500/50 bg-orange-500/10 text-orange-300", border: "border-l-orange-500", label: "High" },
  medium: { chip: "border-amber-500/40 bg-amber-500/10 text-amber-200", border: "border-l-amber-500", label: "Review" },
  info: { chip: "border-white/15 text-muted-foreground", border: "border-l-white/20", label: "Info" },
};

const SOURCE_ICON = {
  risk: ShieldAlert,
  sales: TrendingUp,
  finance: DollarSign,
  customer: UserRound,
} as const;

function AttentionRow({ item }: { item: AttentionItem }): React.JSX.Element {
  const ps = PRIORITY_STYLE[item.priority];
  const Icon = SOURCE_ICON[item.source];
  return (
    <Link
      href={item.href}
      className={`group flex items-start gap-3 border border-l-2 border-white/10 bg-white/[0.02] p-3.5 transition-colors hover:bg-white/[0.05] ${ps.border}`}
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${ps.chip}`}>{ps.label}</span>
          <span className="truncate font-medium">{item.title}</span>
          {item.daysUntil != null && (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {item.daysUntil <= 0 ? "today" : `in ${item.daysUntil}d`}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{item.detail}</p>
      </div>
      <ArrowRight className="mt-0.5 size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </Link>
  );
}

export default async function OpsPage(): Promise<React.JSX.Element> {
  const showMoney = canSeeFinancials(await viewerRole());
  const full = await opsOverview();
  // Members don't see $ — drop finance-sourced items and recompute the brief/summary from the rest.
  const items = showMoney ? full.items : full.items.filter((i) => i.source !== "finance");
  const summary = showMoney ? full.summary : summarize(items);
  const brief = showMoney ? full.brief : opsBrief(items, summary);
  const o = { ...full, items, summary, brief };

  return (
    <main className="mx-auto max-w-3xl p-5 pb-16 md:p-8">
      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <Radar className="size-7" /> Operations Manager
        </h1>
        <p className="text-sm text-muted-foreground">{formatYmdLong(o.today)} · one prioritized view across every system</p>
      </header>

      {/* Brief */}
      <div className="mb-5 border border-white/10 bg-white/[0.03] p-4">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">This morning</div>
        <p className="text-base leading-relaxed">{o.brief}</p>
      </div>

      {/* Summary chips */}
      <section className="mb-6 grid grid-cols-4 gap-2">
        {([
          ["critical", o.summary.critical],
          ["high", o.summary.high],
          ["medium", o.summary.medium],
          ["info", o.summary.info],
        ] as [Priority, number][]).map(([p, n]) => (
          <div key={p} className="surface border border-white/5 p-3 text-center">
            <div className="text-2xl font-bold tabular-nums">{n}</div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{PRIORITY_STYLE[p].label}</div>
          </div>
        ))}
      </section>

      {/* Attention feed */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">What needs attention</h2>
        {o.items.length === 0 ? (
          <div className="flex items-center gap-3 border border-emerald-500/30 bg-emerald-500/[0.06] p-6 text-sm text-emerald-200">
            <CheckCircle2 className="size-5 shrink-0" />
            <span>All clear — no active risks, near-term booking gaps, or labor overruns right now.</span>
          </div>
        ) : (
          <div className="space-y-2">
            {o.items.map((i) => (
              <AttentionRow key={i.key} item={i} />
            ))}
          </div>
        )}
      </section>

      <p className="mt-6 text-[11px] text-muted-foreground">
        The Operations Manager ranks signals the other blades compute — it never decides on its own. Labor signals need
        Connecteam{o.laborVerified ? "" : " (currently unavailable, so labor is excluded, not assumed)"}. Revenue-based
        signals will appear once the Goodshuffle revenue capture lands.
      </p>
    </main>
  );
}
