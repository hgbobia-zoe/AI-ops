// Lost Quotes tracker — the post-mortem view. Win rate, where we leak by deal size, the loss trend,
// team-tagged reasons, and the list of lost quotes to review/tag. Every number is computed from real
// booking outcomes; no invented benchmarks. Goodshuffle stores no loss reason, so reasons are only
// what the team records here.

import Link from "next/link";
import { ArrowLeft, TrendingDown, Percent, DollarSign, Trophy, Lightbulb, AlertTriangle, Info } from "lucide-react";
import { lostQuotesOverview, LOSS_REASONS } from "@/lib/salesos/lostService";
import { LossReasonSelect } from "@/components/LossReasonSelect";
import { formatYmdLong } from "@/lib/dates";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

const money = (n: number | null): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
const pct = (r: number | null): string => (r == null ? "—" : `${Math.round(r * 100)}%`);

const INSIGHT_STYLE = {
  good: "border-emerald-500/30 bg-emerald-500/[0.07] text-emerald-100",
  warn: "border-amber-500/40 bg-amber-500/[0.07] text-amber-100",
  info: "border-white/10 bg-white/[0.03] text-muted-foreground",
} as const;

export default async function LostQuotesPage(): Promise<React.JSX.Element> {
  const showMoney = canSeeFinancials(await viewerRole());
  const o = lostQuotesOverview();
  const maxBucketDecided = o.sizeBuckets.reduce((m, b) => Math.max(m, b.decided), 0);
  const maxYearDecided = o.byYear.reduce((m, y) => Math.max(m, y.decided), 0);

  return (
    <main className="mx-auto max-w-4xl p-5 pb-16 md:p-8">
      <Link href="/salesos" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Sales OS
      </Link>

      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <TrendingDown className="size-7" /> Lost Quotes
        </h1>
        <p className="text-sm text-muted-foreground">
          Where we lose, and why — from {o.stats.decided.toLocaleString("en-US")} decided quotes. Tag reasons to sharpen this over time.
        </p>
      </header>

      {/* Scorecard */}
      <section className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile icon={Percent} label="Win rate" value={pct(o.stats.winRate)} sub={`${o.stats.won} won · ${o.stats.lost} lost`} />
        <Tile icon={Trophy} label="Won" value={o.stats.won.toLocaleString("en-US")} sub={showMoney ? money(o.stats.wonValue) : `${o.stats.open} still open`} />
        <Tile icon={TrendingDown} label="Lost" value={o.stats.lost.toLocaleString("en-US")} sub={showMoney ? money(o.stats.lostValue) + " potential" : "quotes"} tone="warn" />
        {showMoney && <Tile icon={DollarSign} label="Avg lost deal" value={money(o.stats.avgLostValue)} sub={`vs ${money(o.stats.avgWonValue)} won`} />}
        {!showMoney && <Tile icon={Info} label="Open" value={o.stats.open.toLocaleString("en-US")} sub="undecided" />}
      </section>

      {/* Insights */}
      {o.insights.length > 0 && (
        <section className="mb-6 space-y-2">
          {o.insights.map((ins, i) => (
            <div key={i} className={`flex items-start gap-2.5 border p-3 text-sm ${INSIGHT_STYLE[ins.tone]}`}>
              {ins.tone === "warn" ? <AlertTriangle className="mt-0.5 size-4 shrink-0" /> : <Lightbulb className="mt-0.5 size-4 shrink-0" />}
              <span>{ins.text}</span>
            </div>
          ))}
        </section>
      )}

      {/* Win rate by deal size — the leak finder */}
      <section className="mb-6">
        <h2 className="mb-2 text-lg font-semibold">Win rate by deal size</h2>
        <p className="mb-3 text-xs text-muted-foreground">Are we losing the big ones or the small ones? Decided quotes with a known value.</p>
        <div className="border border-white/10">
          {o.sizeBuckets.map((b) => (
            <div key={b.label} className="flex items-center gap-3 border-b border-white/5 px-3 py-2.5 last:border-b-0">
              <div className="w-24 shrink-0 text-sm text-muted-foreground">{b.label}</div>
              <div className="flex h-5 flex-1 items-center gap-2">
                <div className="relative h-full flex-1 bg-white/5">
                  {b.winRate != null && <div className="absolute inset-y-0 left-0 bg-emerald-500/50" style={{ width: `${b.winRate * 100}%` }} />}
                </div>
                <span className="w-10 shrink-0 text-right text-xs font-semibold tabular-nums">{pct(b.winRate)}</span>
              </div>
              <div className="w-28 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                {b.decided === 0 ? "no data" : <><span className="text-emerald-300">{b.won}W</span> · <span className="text-amber-300">{b.lost}L</span></>}
                {maxBucketDecided > 0 && b.decided > 0 && <span className="ml-1 opacity-50">({b.decided})</span>}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Loss trend by year */}
      {o.byYear.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-lg font-semibold">Win/loss by year</h2>
          <div className="border border-white/10">
            {o.byYear.map((y) => (
              <div key={y.year} className="flex items-center gap-3 border-b border-white/5 px-3 py-2.5 last:border-b-0">
                <div className="w-12 shrink-0 text-sm tabular-nums text-muted-foreground">{y.year}</div>
                <div className="flex h-5 flex-1 items-center">
                  {y.decided > 0 && (
                    <>
                      <div className="h-full bg-emerald-500/50" style={{ width: `${maxYearDecided ? (y.won / maxYearDecided) * 100 : 0}%` }} title={`${y.won} won`} />
                      <div className="h-full bg-amber-500/50" style={{ width: `${maxYearDecided ? (y.lost / maxYearDecided) * 100 : 0}%` }} title={`${y.lost} lost`} />
                    </>
                  )}
                </div>
                <div className="w-16 shrink-0 text-right text-xs font-semibold tabular-nums">{pct(y.winRate)}</div>
                <div className="w-24 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                  <span className="text-emerald-300">{y.won}W</span> · <span className="text-amber-300">{y.lost}L</span>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex items-center gap-4 px-1 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 bg-emerald-500/50" /> Won</span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 bg-amber-500/50" /> Lost</span>
          </div>
        </section>
      )}

      {/* Reasons */}
      <section className="mb-6">
        <h2 className="mb-2 text-lg font-semibold">Why we lose</h2>
        {o.reasons.tagged.length === 0 ? (
          <div className="border border-white/10 bg-white/[0.03] p-4 text-sm text-muted-foreground">
            No reasons recorded yet. Goodshuffle doesn&apos;t store why a quote was lost — tag a few below and patterns will build here.
            {o.reasons.untaggedCount > 0 && <span className="ml-1">({o.reasons.untaggedCount.toLocaleString("en-US")} untagged)</span>}
          </div>
        ) : (
          <div className="border border-white/10">
            {o.reasons.tagged.map((r) => (
              <div key={r.reason} className="flex items-center justify-between gap-3 border-b border-white/5 px-3 py-2 last:border-b-0 text-sm">
                <span>{r.reason}</span>
                <span className="tabular-nums text-muted-foreground">
                  {r.count}
                  {showMoney && r.value != null ? <span className="ml-2 text-amber-300">{money(r.value)}</span> : ""}
                </span>
              </div>
            ))}
            {o.reasons.untaggedCount > 0 && (
              <div className="flex items-center justify-between gap-3 px-3 py-2 text-sm text-muted-foreground">
                <span>Untagged</span>
                <span className="tabular-nums">{o.reasons.untaggedCount.toLocaleString("en-US")}</span>
              </div>
            )}
          </div>
        )}
      </section>

      {/* The lost list — review & tag */}
      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Recent lost quotes</h2>
          <span className="text-xs text-muted-foreground">
            {o.lost.length < o.lostTotal ? `showing ${o.lost.length} of ${o.lostTotal.toLocaleString("en-US")}` : `${o.lostTotal.toLocaleString("en-US")} total`}
          </span>
        </div>
        <div className="border border-white/10">
          {o.lost.map((l) => (
            <div key={l.id} className="flex items-center gap-3 border-b border-white/5 px-3 py-2.5 last:border-b-0">
              <div className="min-w-0 flex-1">
                <Link href={`/salesos/lost/${l.id}`} className="truncate text-sm font-medium hover:underline">{l.eventName || l.clientName || `Project ${l.id}`}</Link>
                <div className="text-[11px] text-muted-foreground">
                  {l.clientName || "—"}
                  {l.eventDate ? ` · ${formatYmdLong(l.eventDate)}` : ""}
                  {l.statusLabel ? ` · ${l.statusLabel}` : ""}
                  {" · "}
                  <Link href={`/salesos/lost/${l.id}`} className="text-sky-300/80 hover:text-sky-200">autopsy →</Link>
                </div>
              </div>
              {showMoney && <div className="w-20 shrink-0 text-right text-sm tabular-nums text-amber-200">{money(l.value)}</div>}
              <div className="shrink-0">
                <LossReasonSelect id={l.id} reasons={LOSS_REASONS} initial={l.lossReason} />
              </div>
            </div>
          ))}
        </div>
      </section>

      <p className="mt-6 text-[11px] text-muted-foreground">
        Win/loss from real Goodshuffle outcomes (Contract Signed = won; Lost/Cancelled = lost; open quotes excluded from win rate).
        Loss reasons are team-recorded — no external or competitor data is invented.
      </p>
    </main>
  );
}

function Tile({
  icon: Icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: typeof Percent;
  label: string;
  value: string;
  sub?: string;
  tone?: "warn";
}): React.JSX.Element {
  return (
    <div className="surface border border-white/5 p-3">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </div>
      <div className={`mt-0.5 text-2xl font-bold tabular-nums ${tone === "warn" ? "text-amber-200" : ""}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}
