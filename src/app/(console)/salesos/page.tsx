// AI Sales OS (Phase 1) — the worklist. Every open (unsigned) lead, ranked by a deterministic
// priority score, each with one recommended next action. Built to make an inexperienced salesperson
// act like a seasoned one: what to touch first, and exactly what to do. RULES CALCULATE — no LLM here.

import Link from "next/link";
import { Sparkles, Phone, MessageSquare, Mail, HelpCircle, ChevronRight, AlertTriangle, EyeOff, TrendingDown, Scale, CalendarRange } from "lucide-react";
import { salesLeads } from "@/lib/salesos/service";
import { STAGE_LABEL, type SalesStage, type ActionChannel } from "@/lib/salesos/calc";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

const money = (n: number | null): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));

const STAGE_STYLE: Record<SalesStage, string> = {
  closing: "border-rose-500/40 bg-rose-500/10 text-rose-200",
  unsent: "border-sky-500/40 bg-sky-500/10 text-sky-200",
  follow_up: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  cold: "border-white/15 bg-white/5 text-muted-foreground",
  awaiting: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
};

const STAGE_DOT: Record<SalesStage, string> = {
  closing: "bg-rose-400",
  unsent: "bg-sky-400",
  follow_up: "bg-amber-400",
  cold: "bg-white/40",
  awaiting: "bg-emerald-400",
};

const URGENCY_DOT: Record<string, string> = {
  now: "bg-rose-400",
  today: "bg-amber-400",
  soon: "bg-sky-400",
  monitor: "bg-white/30",
};

function ChannelIcon({ channel }: { channel: ActionChannel }): React.JSX.Element {
  const cls = "size-3.5 shrink-0";
  if (channel === "call") return <Phone className={cls} />;
  if (channel === "text") return <MessageSquare className={cls} />;
  if (channel === "email") return <Mail className={cls} />;
  return <HelpCircle className={cls} />;
}

const STAGE_ORDER: SalesStage[] = ["closing", "unsent", "follow_up", "cold", "awaiting"];

export default async function SalesOsPage({
  searchParams,
}: {
  searchParams: Promise<{ stage?: string }>;
}): Promise<React.JSX.Element> {
  const showMoney = canSeeFinancials(await viewerRole());
  const sp = await searchParams;
  const filter = STAGE_ORDER.includes(sp.stage as SalesStage) ? (sp.stage as SalesStage) : null;

  const os = salesLeads();
  const shown = filter ? os.leads.filter((l) => l.stage === filter) : os.leads;

  return (
    <main className="mx-auto max-w-4xl p-5 pb-16 md:p-8">
      <header className="mb-4">
        <div className="flex items-start justify-between gap-3">
          <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
            <Sparkles className="size-7" /> Sales OS
          </h1>
          <div className="mt-1 flex shrink-0 items-center gap-2">
            <Link
              href="/salesos/trends"
              className="flex items-center gap-1.5 border border-white/10 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
            >
              <CalendarRange className="size-3.5" /> Trends
            </Link>
            {showMoney && (
              <Link
                href="/salesos/bid"
                className="flex items-center gap-1.5 border border-white/10 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
              >
                <Scale className="size-3.5" /> Bid review
              </Link>
            )}
            <Link
              href="/salesos/lost"
              className="flex items-center gap-1.5 border border-white/10 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
            >
              <TrendingDown className="size-3.5" /> Lost quotes
            </Link>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          Your open pipeline, ranked by what to do next. {os.totalOpen} open lead{os.totalOpen === 1 ? "" : "s"}
          {showMoney && os.totalPotential != null ? ` · ${money(os.totalPotential)} potential` : ""}.
        </p>
      </header>

      {/* Phase-1 honesty: we can't see replies yet. */}
      <div className="mb-4 flex items-start gap-2.5 border border-white/10 bg-white/[0.03] p-3 text-xs text-muted-foreground">
        <EyeOff className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Priority is derived from quote age, event date, and deal size. We can&apos;t see customer replies or calls yet,
          so &ldquo;going quiet&rdquo; is inferred from elapsed time — always sanity-check against Goodshuffle before acting.
        </span>
      </div>

      {/* Scorecard + stage filter chips */}
      <section className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="surface border border-white/5 p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Act now</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-2xl font-bold tabular-nums">
            {os.actNowCount > 0 && <span className="inline-block size-2 rounded-full bg-rose-400" />}
            {os.actNowCount}
          </div>
        </div>
        <div className="surface border border-white/5 p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Open leads</div>
          <div className="mt-0.5 text-2xl font-bold tabular-nums">{os.totalOpen}</div>
        </div>
        {showMoney ? (
          <div className="surface col-span-2 border border-white/5 p-3">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Potential pipeline</div>
            <div className="mt-0.5 text-2xl font-bold tabular-nums text-amber-200">{money(os.totalPotential)}</div>
            <div className="text-[10px] text-muted-foreground">Unsigned — potential, not booked revenue.</div>
          </div>
        ) : (
          <div className="surface col-span-2 border border-white/5 p-3">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Closing this window</div>
            <div className="mt-0.5 text-2xl font-bold tabular-nums text-rose-200">{os.counts.closing}</div>
          </div>
        )}
      </section>

      {/* Stage filter chips */}
      <div className="mb-4 flex flex-wrap gap-2">
        <FilterChip href="/salesos" active={filter == null} label="All" count={os.totalOpen} />
        {STAGE_ORDER.map((s) =>
          os.counts[s] > 0 ? (
            <FilterChip key={s} href={`/salesos?stage=${s}`} active={filter === s} label={STAGE_LABEL[s]} count={os.counts[s]} stage={s} />
          ) : null,
        )}
      </div>

      {/* Worklist */}
      {shown.length === 0 ? (
        <div className="surface border border-white/10 p-8 text-center text-sm text-muted-foreground">
          {os.totalOpen === 0 ? "No open leads — every quote is signed, lost, or in the past." : "No leads in this stage."}
        </div>
      ) : (
        <ol className="space-y-2">
          {shown.map((l, i) => {
            const dte = l.signals.daysToEvent;
            const when =
              dte == null ? "No date" : dte < 0 ? `${Math.abs(dte)}d ago` : dte === 0 ? "Today" : dte === 1 ? "Tomorrow" : `in ${dte}d`;
            return (
              <li key={l.id}>
                <Link
                  href={`/salesos/${l.id}`}
                  className="surface flex items-center gap-3 border border-white/10 p-3 transition-colors hover:bg-white/[0.04]"
                >
                  <div className="w-6 shrink-0 text-center text-sm font-bold tabular-nums text-muted-foreground">{filter ? i + 1 : l.priority.score}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold">{l.eventName || l.clientName || `Project ${l.id}`}</span>
                      <span className={`shrink-0 border px-1.5 py-0.5 text-[10px] font-medium ${STAGE_STYLE[l.stage]}`}>{STAGE_LABEL[l.stage]}</span>
                      {l.statusLabel && (
                        <span className="shrink-0 border border-white/10 px-1.5 py-0.5 text-[10px] text-muted-foreground" title="Goodshuffle status">
                          {l.statusLabel}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className={`inline-block size-1.5 rounded-full ${URGENCY_DOT[l.action.urgency]}`} />
                      <ChannelIcon channel={l.action.channel} />
                      <span className="truncate text-foreground/90">{l.action.action}</span>
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className={`text-xs tabular-nums ${dte != null && dte >= 0 && dte <= 14 ? "text-rose-200" : "text-muted-foreground"}`}>{when}</div>
                    {showMoney && <div className="text-sm font-semibold tabular-nums text-amber-200">{money(l.value)}</div>}
                  </div>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </Link>
              </li>
            );
          })}
        </ol>
      )}

      <p className="mt-6 flex items-start gap-1.5 text-[11px] text-muted-foreground">
        <AlertTriangle className="mt-0.5 size-3 shrink-0" />
        Recommendations only — no message is sent automatically. Approval-based outreach and reply visibility come in a later phase.
      </p>
    </main>
  );
}

function FilterChip({
  href,
  active,
  label,
  count,
  stage,
}: {
  href: string;
  active: boolean;
  label: string;
  count: number;
  stage?: SalesStage;
}): React.JSX.Element {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={`flex items-center gap-1.5 border px-2.5 py-1 text-xs transition-colors ${
        active ? "border-foreground bg-white/10 text-foreground" : `border-white/10 text-muted-foreground hover:bg-white/5 ${stage ? "" : ""}`
      }`}
    >
      {stage && <span className={`inline-block size-1.5 rounded-full ${STAGE_DOT[stage]}`} />}
      {label}
      <span className="tabular-nums opacity-70">{count}</span>
    </Link>
  );
}
