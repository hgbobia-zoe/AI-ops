// Controlled Automation (MVP8) — OBSERVE MODE. This screen shows the actions the platform WOULD
// take, derived deterministically from live risks and booking gaps. Nothing here executes: no
// texts, no Goodshuffle writes, no crew changes. Enabling execution is a separate, gated step.

import { Workflow, Lock, RotateCcw, Globe, ArrowUpRight } from "lucide-react";
import { automationOverview, type ObservedAction } from "@/lib/automation/service";
import type { Tier, Target } from "@/lib/automation/actions";

export const dynamic = "force-dynamic";

const TIER_LABEL: Record<Tier, string> = { observe: "Observe", recommend: "Recommend", prepare: "Prepare", approve: "Approve", auto: "Auto" };
const TIER_STYLE: Record<Tier, string> = {
  approve: "border-orange-500/50 text-orange-300",
  prepare: "border-sky-500/40 text-sky-300",
  recommend: "border-amber-500/40 text-amber-200",
  auto: "border-emerald-500/40 text-emerald-300",
  observe: "border-white/15 text-muted-foreground",
};
const TARGET_LABEL: Record<Target, string> = { dispatch: "Dispatch", connecteam: "Connecteam", goodshuffle: "Goodshuffle", slack: "Slack", internal: "Internal" };

function fmtSince(iso: string): string {
  if (!iso) return "";
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return "first seen today";
  return `observed ${days}d`;
}

function ActionRow({ p }: { p: ObservedAction }): React.JSX.Element {
  return (
    <div className="border border-white/10 bg-white/[0.02] p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${TIER_STYLE[p.tier]}`}>{TIER_LABEL[p.tier]}</span>
        <span className="border border-white/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{TARGET_LABEL[p.target]}</span>
        {p.outward && (
          <span className="flex items-center gap-1 border border-red-500/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-red-300">
            <Globe className="size-3" /> Outward
          </span>
        )}
        {p.reversible && (
          <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            <RotateCcw className="size-3" /> Reversible
          </span>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">{fmtSince(p.firstObservedAt)}</span>
      </div>
      <div className="mt-2 font-medium">{p.title}</div>
      <p className="mt-0.5 text-sm text-muted-foreground">{p.detail}</p>
      <div className="mt-2.5 flex items-center gap-2">
        <span className="cursor-not-allowed border border-white/10 px-2.5 py-1 text-xs text-muted-foreground" title="Execution is not wired — observe mode">
          Approve &amp; run · disabled
        </span>
        <span className="text-[11px] text-muted-foreground">wiring pending your go-ahead</span>
      </div>
    </div>
  );
}

export default async function AutomationPage(): Promise<React.JSX.Element> {
  const a = automationOverview();

  return (
    <main className="mx-auto max-w-3xl p-5 pb-16 md:p-8">
      <header className="mb-4">
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <Workflow className="size-7" /> Controlled Automation
        </h1>
        <p className="text-sm text-muted-foreground">The actions the platform would take — none of them run yet.</p>
      </header>

      {/* Observe-mode banner — the load-bearing safety statement */}
      <div className="mb-6 flex items-start gap-3 border border-emerald-500/30 bg-emerald-500/[0.06] p-4">
        <Lock className="mt-0.5 size-5 shrink-0 text-emerald-300" />
        <div className="text-sm">
          <div className="font-semibold text-emerald-200">Observe mode — nothing executes</div>
          <p className="mt-1 text-muted-foreground">
            Everything below is a <b>proposal</b> derived from live risks and booking gaps. No texts are sent, no Goodshuffle
            data is changed, no crew is moved. Each action shows its intended tier and whether it&apos;s outward-facing, so
            you can decide — action by action — what should ever run automatically.
          </p>
        </div>
      </div>

      {/* Summary */}
      <section className="mb-6 grid grid-cols-3 gap-2 sm:grid-cols-6">
        {(["approve", "prepare", "recommend", "auto", "observe"] as Tier[]).map((t) => (
          <div key={t} className="surface border border-white/5 p-3 text-center">
            <div className="text-xl font-bold tabular-nums">{a.byTier[t]}</div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{TIER_LABEL[t]}</div>
          </div>
        ))}
        <div className="surface border border-red-500/20 p-3 text-center">
          <div className="text-xl font-bold tabular-nums text-red-300">{a.outwardCount}</div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Outward</div>
        </div>
      </section>

      {/* Proposed actions */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Proposed actions ({a.total})</h2>
        {a.total === 0 ? (
          <div className="border border-white/10 p-8 text-center text-sm text-muted-foreground">
            Nothing to propose right now — no active risks with a recommended action, and no near-term booking gaps.
          </div>
        ) : (
          <div className="space-y-2">
            {a.proposals.map((p) => (
              <ActionRow key={p.key} p={p} />
            ))}
          </div>
        )}
      </section>

      {/* Tier ladder explainer */}
      <section className="mt-8 border border-white/10 p-4 text-sm">
        <div className="mb-2 flex items-center gap-2 font-semibold">
          <ArrowUpRight className="size-4" /> The automation ladder
        </div>
        <p className="text-muted-foreground">
          Each action is tagged with how it should be handled once execution is enabled:
          <b className="text-foreground"> Observe</b> (log only, where we are now) →
          <b className="text-foreground"> Recommend</b> (surface it) →
          <b className="text-foreground"> Prepare</b> (draft/stage it) →
          <b className="text-foreground"> Approve</b> (one-click human yes) →
          <b className="text-foreground"> Auto</b> (runs on its own). Outward-facing and Goodshuffle actions default to
          Approve; only safe, reversible internal refreshes are ever auto candidates.
        </p>
      </section>
    </main>
  );
}
