// AI Sales OS — the Sales Command Center (Phase 7). Every open lead, ranked by what to do next:
// the customer's evidence-driven STATE + the single Next Best Action, highest-value/most time-sensitive
// on top. A big deal that just replied outranks a small one sitting untouched. RULES rank; the state is
// AI-interpreted from real replies (labelled), never invented.

import Link from "next/link";
import { Sparkles, ChevronRight, AlertTriangle, TrendingDown, Scale, CalendarRange, Zap, MessageCircle } from "lucide-react";
import { salesCommandCenter, type QueueItem } from "@/lib/salesos/commandCenter";
import { NBA_LABEL, type NbaAction } from "@/lib/salesos/nba";
import { type CustomerState } from "@/lib/salesos/state";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

const money = (n: number | null): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));

// Action visual weight — the urgent ones read hot.
const ACTION_STYLE: Record<NbaAction, string> = {
  CALL_NOW: "border-rose-500/50 bg-rose-500/15 text-rose-100",
  HANDLE_OBJECTION: "border-amber-500/50 bg-amber-500/15 text-amber-100",
  CLOSE: "border-emerald-500/50 bg-emerald-500/15 text-emerald-100",
  ESCALATE: "border-fuchsia-500/50 bg-fuchsia-500/15 text-fuchsia-100",
  VERIFY_AVAILABILITY: "border-sky-500/40 bg-sky-500/10 text-sky-100",
  CONFIRM_LOGISTICS: "border-sky-500/40 bg-sky-500/10 text-sky-100",
  ASK_DISCOVERY: "border-sky-500/40 bg-sky-500/10 text-sky-100",
  REVIEW_QUOTE: "border-white/20 bg-white/5 text-foreground",
  SEND_SMS: "border-sky-500/40 bg-sky-500/10 text-sky-100",
  FOLLOW_UP: "border-white/15 bg-white/5 text-muted-foreground",
  WAIT: "border-white/10 bg-white/5 text-muted-foreground",
  NO_ACTION: "border-white/10 bg-white/5 text-muted-foreground",
};

const STATE_TONE: Partial<Record<CustomerState, string>> = {
  PRICE_OBJECTION: "text-amber-300",
  COMPETITOR_COMPARISON: "text-amber-300",
  READY_TO_BOOK: "text-emerald-300",
  EVALUATING: "text-sky-300",
  DORMANT: "text-muted-foreground",
};

function repliedLabel(mins: number | null): string | null {
  if (mins == null) return null;
  if (mins < 60) return `replied ${mins}m ago`;
  if (mins < 1440) return `replied ${Math.round(mins / 60)}h ago`;
  return null; // older than a day isn't "hot"
}

export default async function SalesCommandCenter(): Promise<React.JSX.Element> {
  const showMoney = canSeeFinancials(await viewerRole());
  const cc = salesCommandCenter();

  return (
    <main className="mx-auto max-w-4xl p-5 pb-16 md:p-8">
      <header className="mb-4">
        <div className="flex items-start justify-between gap-3">
          <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
            <Sparkles className="size-7" /> Sales OS
          </h1>
          <div className="mt-1 flex shrink-0 items-center gap-2">
            <Link href="/salesos/trends" className="flex items-center gap-1.5 border border-white/10 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground">
              <CalendarRange className="size-3.5" /> Trends
            </Link>
            {showMoney && (
              <Link href="/salesos/bid" className="flex items-center gap-1.5 border border-white/10 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground">
                <Scale className="size-3.5" /> Bid review
              </Link>
            )}
            <Link href="/salesos/lost" className="flex items-center gap-1.5 border border-white/10 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground">
              <TrendingDown className="size-3.5" /> Lost quotes
            </Link>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          {cc.needAttention} action{cc.needAttention === 1 ? "" : "s"} need attention · sorted by what matters most right now.
        </p>
      </header>

      {/* Scorecard */}
      <section className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="surface border border-white/5 p-3">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground"><Zap className="size-3.5" /> Need attention</div>
          <div className="mt-0.5 text-2xl font-bold tabular-nums">{cc.needAttention}</div>
        </div>
        <div className="surface border border-white/5 p-3">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground"><MessageCircle className="size-3.5" /> Just replied</div>
          <div className="mt-0.5 text-2xl font-bold tabular-nums text-sky-200">{cc.justReplied}</div>
          <div className="text-[10px] text-muted-foreground">in the last 24h</div>
        </div>
        <div className="surface col-span-2 border border-white/5 p-3 sm:col-span-1">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{showMoney ? "Potential pipeline" : "Open leads"}</div>
          <div className="mt-0.5 text-2xl font-bold tabular-nums text-amber-200">{showMoney ? money(cc.totalPotential) : cc.items.length}</div>
        </div>
      </section>

      {cc.items.length === 0 ? (
        <div className="surface border border-white/10 p-8 text-center text-sm text-muted-foreground">No open leads — the pipeline is clear.</div>
      ) : (
        <ol className="space-y-2">
          {cc.items.map((it) => (
            <QueueRow key={it.id} it={it} showMoney={showMoney} />
          ))}
        </ol>
      )}

      <p className="mt-6 flex items-start gap-1.5 text-[11px] text-muted-foreground">
        <AlertTriangle className="mt-0.5 size-3 shrink-0" />
        State is FACT from Goodshuffle where known, otherwise inferred from the customer&apos;s own reply (shown as evidence). Recommendations only —
        no message sends without your review.
      </p>
    </main>
  );
}

function QueueRow({ it, showMoney }: { it: QueueItem; showMoney: boolean }): React.JSX.Element {
  const replied = repliedLabel(it.repliedMinutesAgo);
  const dte = it.daysToEvent;
  const when = dte == null ? "no date" : dte < 0 ? `${Math.abs(dte)}d ago` : dte === 0 ? "today" : dte === 1 ? "tomorrow" : `in ${dte}d`;
  return (
    <li>
      <Link href={`/salesos/${it.id}`} className="surface flex items-center gap-3 border border-white/10 p-3 transition-colors hover:bg-white/[0.04]">
        <div className="w-8 shrink-0 text-center text-sm font-bold tabular-nums text-muted-foreground">{it.nba.priority}</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-semibold">{it.eventName || it.clientName || `Project ${it.id}`}</span>
            <span className={`shrink-0 text-[11px] font-medium ${STATE_TONE[it.state.state] ?? "text-muted-foreground"}`}>{it.stateLabel}</span>
            {replied && <span className="shrink-0 border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-200">{replied}</span>}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className={`shrink-0 border px-1.5 py-0.5 text-[10px] font-semibold ${ACTION_STYLE[it.nba.action]}`}>{NBA_LABEL[it.nba.action]}</span>
            <span className="truncate text-xs text-muted-foreground">{it.nba.objective}</span>
          </div>
          {it.lastReplyPreview && replied && <div className="mt-1 truncate text-[11px] italic text-sky-200/80">“{it.lastReplyPreview}”</div>}
        </div>
        <div className="shrink-0 text-right">
          <div className={`text-xs tabular-nums ${dte != null && dte >= 0 && dte <= 14 ? "text-rose-200" : "text-muted-foreground"}`}>{when}</div>
          {showMoney && <div className="text-sm font-semibold tabular-nums text-amber-200">{money(it.value)}</div>}
        </div>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
}
