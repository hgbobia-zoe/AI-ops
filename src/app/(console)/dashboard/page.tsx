// Zoe Operations Command Center — the management home. Answers, in ~10 seconds: are we on pace for
// revenue, what's happening today, do we have the people/capacity, what's about to go wrong, and what
// needs attention. Built entirely on existing blade services via commandCenter(); money is Owner/Admin
// only. Dispatch remains the operations workspace — this is the command layer above it.

import Link from "next/link";
import {
  AlertTriangle, ArrowRight, DollarSign, TrendingUp, Users, Radar, Truck, Boxes,
  CalendarDays, Gauge, Clock, CircleCheck, CircleDot, Sparkles,
} from "lucide-react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { commandCenter } from "@/lib/command/service";
import { pctOfTarget, type OpStatus } from "@/lib/command/calc";
import { formatYmdLong } from "@/lib/dates";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";
import type { Priority } from "@/lib/ops/manager";

export const dynamic = "force-dynamic";

const money = (n: number | null | undefined): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
const moneyK = (n: number | null | undefined): string =>
  n == null ? "—" : Math.abs(n) >= 1000 ? "$" + (n / 1000).toFixed(1) + "K" : "$" + Math.round(n);

const STATUS_META: Record<OpStatus, { label: string; cls: string }> = {
  quiet: { label: "Quiet", cls: "border-white/15 bg-white/5 text-muted-foreground" },
  normal: { label: "Normal", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" },
  busy: { label: "Busy", cls: "border-sky-500/40 bg-sky-500/10 text-sky-300" },
  "at-risk": { label: "At risk", cls: "border-red-500/40 bg-red-500/10 text-red-300" },
};

const P_TONE: Record<Priority, string> = { critical: "border-l-red-500", high: "border-l-orange-500", medium: "border-l-amber-500", info: "border-l-white/20" };
const P_CHIP: Record<Priority, string> = {
  critical: "bg-red-500/15 text-red-300",
  high: "bg-orange-500/15 text-orange-300",
  medium: "bg-amber-500/15 text-amber-300",
  info: "bg-white/10 text-muted-foreground",
};

const CAP_TONE: Record<string, string> = {
  CONSTRAINED: "text-red-300 border-red-500/40 bg-red-500/10",
  TIGHT: "text-amber-300 border-amber-500/40 bg-amber-500/10",
  UNVERIFIED: "text-muted-foreground border-white/15 bg-white/5",
  AVAILABLE: "text-emerald-300 border-emerald-500/40 bg-emerald-500/10",
};

// Focus filters — clicking a tile or chip narrows the page to one lane for a clean, single-purpose
// view. `null` = show everything. Each entry lists the section keys visible in that focus.
type Focus = "all" | "attention" | "today" | "people" | "revenue";
const FOCUS_GROUPS: Record<Focus, ReadonlySet<string> | null> = {
  all: null,
  attention: new Set(["attention"]),
  today: new Set(["brief", "attention", "todayOps", "outlook"]),
  people: new Set(["people", "capacity"]),
  revenue: new Set(["revenue", "salesPipeline"]),
};
const FOCUS_KEYS: Focus[] = ["all", "attention", "today", "people", "revenue"];

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ focus?: string }>;
}): Promise<React.JSX.Element> {
  const showMoney = canSeeFinancials(await viewerRole());
  const c = await commandCenter();
  const s = STATUS_META[c.status];

  const sp = await searchParams;
  let focus: Focus = FOCUS_KEYS.includes(sp.focus as Focus) ? (sp.focus as Focus) : "all";
  if (focus === "revenue" && !showMoney) focus = "all"; // Members have no revenue lane
  const show = (k: string): boolean => focus === "all" || Boolean(FOCUS_GROUPS[focus]?.has(k));
  const chips: { key: Focus; label: string }[] = [
    { key: "all", label: "Everything" },
    { key: "attention", label: "Attention" },
    { key: "today", label: "Today" },
    { key: "people", label: "People" },
    ...(showMoney ? [{ key: "revenue" as Focus, label: "Revenue" }] : []),
  ];
  const focusHref = (k: Focus): string => (k === "all" ? "/dashboard" : `/dashboard?focus=${k}`);
  const attention = (showMoney ? c.attention : c.attention.filter((i) => i.source !== "finance")).slice(0, 7);

  const wk = c.finance?.revenue;
  const wkPct = pctOfTarget(wk?.signed ?? null, wk?.target ?? null);
  const wkRemaining = wk?.target != null && wk?.signed != null ? Math.max(0, wk.target - wk.signed) : null;

  return (
    <main className="mx-auto max-w-6xl p-4 pb-16 md:p-8">
      <AutoRefresh seconds={120} />

      {/* Header */}
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight md:text-3xl">Command Center</h1>
          <p className="text-sm text-muted-foreground">{formatYmdLong(c.today)}</p>
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium ${s.cls}`}>
          <CircleDot className="size-3.5" /> {s.label}
        </span>
      </header>

      {/* Focus filter — click to declutter down to one lane (tiles below do the same) */}
      <div className="mb-5 flex flex-wrap gap-2">
        {chips.map((ch) => (
          <Link
            key={ch.key}
            href={focusHref(ch.key)}
            aria-current={focus === ch.key ? "page" : undefined}
            className={`rounded-full border px-3 py-1 text-sm transition-colors ${
              focus === ch.key ? "border-foreground bg-white/10 font-medium text-foreground" : "border-white/10 text-muted-foreground hover:bg-white/5"
            }`}
          >
            {ch.label}
          </Link>
        ))}
      </div>

      {/* AI Operations Summary — deterministic, from real system data */}
      {c.brief && show("brief") && (
        <div className="mb-5 flex items-start gap-2.5 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-sky-300" />
          <p className="text-sm leading-relaxed text-foreground/90">{c.brief}</p>
        </div>
      )}

      {/* SECTION 1 — Business Pulse */}
      <section className="mb-6 grid grid-cols-2 gap-3 [&>a]:min-w-0 lg:grid-cols-4">
        {showMoney ? (
          <PulseCard
            icon={<DollarSign className="size-4" />}
            label="Revenue this week"
            big={money(wk?.signed ?? null)}
            sub={
              wk?.target == null ? "no target set" :
              wkPct == null ? `target ${money(wk.target)}` :
              `${wkPct}% of ${money(wk.target)}${wkRemaining ? ` · ${money(wkRemaining)} to go` : " · target met"}`
            }
            tone={wkPct != null && wkPct >= 100 ? "good" : undefined}
            href={focusHref("revenue")}
            active={focus === "revenue"}
          />
        ) : (
          <PulseCard icon={<CalendarDays className="size-4" />} label="Events today" big={String(c.today_ops.events)} sub="scheduled" href={focusHref("today")} active={focus === "today"} />
        )}
        {showMoney && (
          <PulseCard icon={<TrendingUp className="size-4" />} label={`${c.year} revenue`} big={moneyK(c.sales.totalSignedRevenue)} sub={`${c.sales.totalSignedCount} signed · ${moneyK(c.sales.totalActionNeededRevenue)} to win`} href={focusHref("revenue")} active={focus === "revenue"} />
        )}
        <PulseCard icon={<Truck className="size-4" />} label="Today" big={`${c.today_ops.events}`} sub={`${c.today_ops.activeRoutes} routes · ${c.today_ops.trucksUsed}/${c.today_ops.fleetSize} trucks`} href={focusHref("today")} active={focus === "today"} unit="events" />
        <PulseCard icon={<Users className="size-4" />} label="Crew today" big={c.people.verified ? String(c.people.peopleCount) : "—"} sub={c.people.verified ? `${plural(c.people.drivers, "driver")} · ${c.people.prep} prep` : "not connected"} href={focusHref("people")} active={focus === "people"} warn={!c.people.verified} />
      </section>

      {/* SECTION 2 — Attention Required (dominant) */}
      {show("attention") && (
      <section className="mb-6">
        <SectionHead icon={<Radar className="size-4" />} title="Attention required" href="/ops" hrefLabel="Ops Manager" />
        {attention.length === 0 ? (
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.06] p-4 text-sm text-emerald-200">
            All operations are currently on track.
          </div>
        ) : (
          <div className="space-y-1.5">
            {attention.map((i) => (
              <Link key={i.key} href={i.href} className={`flex items-center gap-3 rounded-lg border border-l-[3px] border-white/10 bg-white/[0.02] px-3 py-2.5 hover:bg-white/[0.05] ${P_TONE[i.priority]}`}>
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${P_CHIP[i.priority]}`}>{i.priority}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{i.title}</span>
                  {i.detail && <span className="block truncate text-xs text-muted-foreground">{i.detail}</span>}
                </span>
                {i.daysUntil != null && <span className="shrink-0 text-[11px] text-muted-foreground">{i.daysUntil <= 0 ? "today" : `in ${i.daysUntil}d`}</span>}
                <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
              </Link>
            ))}
          </div>
        )}
      </section>
      )}

      {/* SECTION 3 — Today's Operations + People */}
      {(show("todayOps") || show("people")) && (
      <div className={`mb-6 grid gap-4 [&>section]:min-w-0 ${show("todayOps") && show("people") ? "lg:grid-cols-2" : ""}`}>
        {show("todayOps") && (
        <section>
          <SectionHead icon={<Truck className="size-4" />} title="Today's operations" href="/dispatch" hrefLabel="Dispatch" />
          <div className="rounded-2xl border border-white/10 p-4">
            <div className="grid grid-cols-3 gap-3 text-center">
              <Stat n={c.today_ops.stops} label="stops" />
              <Stat n={c.today_ops.deliveries} label="deliveries" />
              <Stat n={c.today_ops.pickups} label="pickups" />
            </div>
            {c.today_ops.stops === 0 && c.today_ops.events > 0 && (
              <p className="mt-3 text-xs text-muted-foreground">{plural(c.today_ops.events, "event")} booked today — route not loaded yet.</p>
            )}
            <div className="mt-4 space-y-2">
              <ProgressRow done={c.today_ops.completed} total={c.today_ops.stops} inProgress={c.today_ops.inProgress} remaining={c.today_ops.remaining} />
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1"><CircleCheck className="size-3.5 text-emerald-400" /> {c.today_ops.completed} done</span>
                <span className="inline-flex items-center gap-1"><CircleDot className="size-3.5 text-sky-400" /> {c.today_ops.inProgress} in progress</span>
                <span className="inline-flex items-center gap-1"><Clock className="size-3.5" /> {c.today_ops.remaining} remaining</span>
                <span className="inline-flex items-center gap-1"><Truck className="size-3.5" /> {c.today_ops.driversAssigned} drivers assigned</span>
                {c.today_ops.exceptions > 0 && <span className="inline-flex items-center gap-1 text-amber-400"><AlertTriangle className="size-3.5" /> {c.today_ops.exceptions} exceptions</span>}
              </div>
              {showMoney && c.today_ops.scheduledRevenue != null && (
                <div className="pt-1 text-sm"><span className="text-muted-foreground">Scheduled revenue today: </span><span className="font-semibold text-emerald-300">{money(c.today_ops.scheduledRevenue)}</span></div>
              )}
            </div>
          </div>
        </section>
        )}

        {show("people") && (
        <section>
          <SectionHead icon={<Users className="size-4" />} title="People on schedule" href="/staffing" hrefLabel="Staffing" />
          <div className="rounded-2xl border border-white/10 p-4">
            {!c.people.verified ? (
              <p className="text-sm text-muted-foreground">Staffing unavailable — Connecteam not connected. <Link href="/admin" className="underline">Connect →</Link></p>
            ) : c.people.peopleCount === 0 ? (
              <p className="text-sm text-muted-foreground">No one scheduled today.</p>
            ) : (
              <>
                <div className="mb-3 flex items-baseline gap-2">
                  <span className="text-2xl font-bold tabular-nums">{c.people.peopleCount}</span>
                  <span className="text-sm text-muted-foreground">scheduled · {plural(c.people.drivers, "driver")} · {c.people.prep} prep{c.people.openShifts > 0 ? ` · ${plural(c.people.openShifts, "open shift")}` : ""}</span>
                </div>
                <div className="max-h-56 space-y-1 overflow-y-auto">
                  {c.people.assignments.slice(0, 12).map((a, idx) => (
                    <div key={idx} className="flex items-center gap-2 text-sm">
                      <span className="w-16 shrink-0 tabular-nums text-muted-foreground">{a.start}</span>
                      <span className="min-w-0 flex-1 truncate">{a.name}</span>
                      <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{a.role}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </section>
        )}
      </div>
      )}

      {/* SECTION 4 — Capacity + 7-Day Outlook */}
      {(show("capacity") || show("outlook")) && (
      <div className={`mb-6 grid gap-4 [&>section]:min-w-0 ${show("capacity") && show("outlook") ? "lg:grid-cols-2" : ""}`}>
        {show("capacity") && (
        <section>
          <SectionHead icon={<Gauge className="size-4" />} title="Upcoming capacity" href="/risk" hrefLabel="Event Risk" />
          <div className="rounded-2xl border border-white/10 p-4">
            {c.capacity.length === 0 ? (
              <p className="text-sm text-muted-foreground">No capacity pressure detected in the upcoming days.</p>
            ) : (
              <div className="space-y-2">
                {c.capacity.map((d) => (
                  <div key={d.date} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{new Date(`${d.date}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })}</div>
                      <div className="truncate text-xs text-muted-foreground">{d.reasons.join(" · ")}</div>
                    </div>
                    <span className={`shrink-0 rounded border px-2 py-0.5 text-[11px] font-semibold ${CAP_TONE[d.verdict] ?? CAP_TONE.UNVERIFIED}`}>{d.verdict}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
        )}

        {show("outlook") && (
        <section>
          <SectionHead icon={<CalendarDays className="size-4" />} title="7-day outlook" href="/sales" hrefLabel="Sales" />
          <div className="rounded-2xl border border-white/10 p-2">
            {c.outlook.map((d) => (
              <div key={d.date} className={`flex items-center gap-3 rounded-lg px-2 py-1.5 ${d.isToday ? "bg-white/[0.04]" : ""}`}>
                <span className="w-10 shrink-0 text-sm font-medium text-muted-foreground">{d.dow}</span>
                <span className="w-10 shrink-0 text-sm tabular-nums">{d.jobs || "—"}<span className="text-[10px] text-muted-foreground"> jobs</span></span>
                {showMoney && <span className="w-16 shrink-0 text-sm tabular-nums text-emerald-300">{d.revenue != null ? moneyK(d.revenue) : ""}</span>}
                <span className="flex-1" />
                {d.verdict && d.verdict !== "AVAILABLE" && <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold ${CAP_TONE[d.verdict] ?? CAP_TONE.UNVERIFIED}`}>{d.verdict}</span>}
              </div>
            ))}
          </div>
        </section>
        )}
      </div>
      )}

      {/* SECTION 5 — Revenue Forecast + Sales Pipeline (money only) */}
      {showMoney && (show("revenue") || show("salesPipeline")) && (
        <div className={`grid gap-4 [&>section]:min-w-0 ${show("revenue") && show("salesPipeline") ? "lg:grid-cols-2" : ""}`}>
          {show("revenue") && (
          <section>
            <SectionHead icon={<DollarSign className="size-4" />} title="Revenue" href="/sales" hrefLabel="Sales" />
            <div className="rounded-2xl border border-white/10 p-4">
              <div className="grid grid-cols-3 gap-3">
                <MetricCol label="Committed" value={moneyK(c.sales.totalSignedRevenue)} tone="text-emerald-300" hint={`${c.sales.totalSignedCount} signed`} />
                <MetricCol label="Open pipeline" value={moneyK(c.pipeline.quote.value)} tone="text-amber-300" hint={`${c.pipeline.quote.count} quotes`} />
                <MetricCol label="Potential" value={moneyK((c.sales.totalSignedRevenue ?? 0) + (c.pipeline.quote.value ?? 0))} tone="text-foreground" hint="if all win" />
              </div>
              {/* Real monthly signed-revenue trend for the year */}
              <div className="mt-4">
                <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{c.year} signed revenue by month</div>
                <MonthTrend months={c.sales.months} />
              </div>
              <p className="mt-3 text-[11px] text-muted-foreground">Probability-weighted forecast needs per-stage win rates — a future Goodshuffle-stage integration. Committed and pipeline above are live.</p>
            </div>
          </section>
          )}

          {show("salesPipeline") && (
          <section>
            <SectionHead icon={<Boxes className="size-4" />} title="Sales pipeline" href="/sales" hrefLabel="Sales" />
            <div className="rounded-2xl border border-white/10 p-4">
              <div className="space-y-2.5">
                <PipeRow label="Signed (committed)" count={c.pipeline.signed.count} value={money(c.pipeline.signed.value)} tone="bg-emerald-500/60" />
                <PipeRow label="Open quotes (action needed)" count={c.pipeline.quote.count} value={money(c.pipeline.quote.value)} tone="bg-amber-500/50" />
                <PipeRow label="Lost / cancelled" count={c.pipeline.lost.count} value={money(c.pipeline.lost.value)} tone="bg-white/15" muted />
              </div>
              <p className="mt-3 text-[11px] text-muted-foreground">Upcoming bookings by Goodshuffle status. Finer stages (leads, follow-up, likely) aren&apos;t exposed by Goodshuffle — this is the real 3-way split.</p>
            </div>
          </section>
          )}
        </div>
      )}
    </main>
  );
}

function PulseCard({ icon, label, big, sub, href, warn, tone, unit, active }: { icon: React.ReactNode; label: string; big: string; sub?: string; href: string; warn?: boolean; tone?: "good"; unit?: string; active?: boolean }): React.JSX.Element {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`surface rounded-2xl border p-4 transition-colors ${active ? "border-foreground/50 bg-white/[0.05]" : "border-white/5 hover:border-white/15"}`}
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">{icon} {label}</div>
      <div className={`text-2xl font-bold tabular-nums md:text-3xl ${tone === "good" ? "text-emerald-300" : ""}`}>{big}{unit && <span className="ml-1 text-sm font-medium text-muted-foreground">{unit}</span>}</div>
      {sub && <div className={`mt-0.5 truncate text-xs ${warn ? "text-amber-400" : "text-muted-foreground"}`}>{sub}</div>}
    </Link>
  );
}

function SectionHead({ icon, title, href, hrefLabel }: { icon: React.ReactNode; title: string; href: string; hrefLabel: string }): React.JSX.Element {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h2 className="flex items-center gap-2 text-lg font-semibold">{icon} {title}</h2>
      <Link href={href} className="text-xs text-muted-foreground hover:text-foreground">{hrefLabel} →</Link>
    </div>
  );
}

function Stat({ n, label }: { n: number; label: string }): React.JSX.Element {
  return (
    <div>
      <div className="text-2xl font-bold tabular-nums">{n}</div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

function ProgressRow({ done, total, inProgress, remaining }: { done: number; total: number; inProgress: number; remaining: number }): React.JSX.Element {
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);
  return (
    <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-white/5">
      <div className="bg-emerald-500/70" style={{ width: `${pct(done)}%` }} />
      <div className="bg-sky-500/70" style={{ width: `${pct(inProgress)}%` }} />
      <div className="bg-white/10" style={{ width: `${pct(remaining)}%` }} />
    </div>
  );
}

function MetricCol({ label, value, tone, hint }: { label: string; value: string; tone: string; hint?: string }): React.JSX.Element {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-xl font-bold tabular-nums ${tone}`}>{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function MonthTrend({ months }: { months: { label: string; signedRevenue: number | null }[] }): React.JSX.Element {
  const max = months.reduce((m, x) => Math.max(m, x.signedRevenue ?? 0), 0);
  return (
    <div className="flex h-16 items-end gap-1">
      {months.map((m) => {
        const h = max > 0 ? ((m.signedRevenue ?? 0) / max) * 100 : 0;
        return (
          <div key={m.label} className="flex flex-1 flex-col items-center gap-1" title={`${m.label}: ${m.signedRevenue == null ? "—" : "$" + Math.round(m.signedRevenue).toLocaleString()}`}>
            <div className="flex w-full flex-1 items-end">
              <div className="w-full rounded-sm bg-emerald-500/50" style={{ height: `${Math.max(h, m.signedRevenue ? 4 : 0)}%` }} />
            </div>
            <div className="text-[8px] text-muted-foreground">{m.label[0]}</div>
          </div>
        );
      })}
    </div>
  );
}

function PipeRow({ label, count, value, tone, muted }: { label: string; count: number; value: string; tone: string; muted?: boolean }): React.JSX.Element {
  return (
    <div className={`flex items-center gap-3 ${muted ? "opacity-70" : ""}`}>
      <span className={`size-2.5 shrink-0 rounded-sm ${tone}`} />
      <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
      <span className="shrink-0 text-sm tabular-nums text-muted-foreground">{count}</span>
      <span className="w-20 shrink-0 text-right text-sm font-semibold tabular-nums">{value}</span>
    </div>
  );
}
