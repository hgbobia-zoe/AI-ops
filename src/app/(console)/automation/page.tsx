// Automation (MVP8): the register of what the platform does on its own, plus what it suggests a person do.
//
// Read only. Scheduled jobs, Goodshuffle write-backs, AI approvals and the on/off switches all come from
// the records those automations already keep (src/lib/automation/register.ts). The suggestions section is
// the original observe-mode proposer: it still executes nothing and links to where a person acts.

import Link from "next/link";
import { Workflow, ArrowUpRight, ExternalLink } from "lucide-react";
import { automationRegister, groupJobs, type RegisterJob } from "@/lib/automation/register";
import { automationOverview, type ObservedAction } from "@/lib/automation/service";
import type { Tier, Target } from "@/lib/automation/actions";
import type { JobState } from "@/lib/runtime/jobs";
import { DISPLAY_TZ } from "@/lib/dates";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials, canManageSettings } from "@/lib/auth/roles";
import { WriteBacksNeedingPerson } from "@/components/automation/WriteBacksNeedingPerson";
import { outboxThresholds } from "@/lib/aiorg/outboxHealth";
import type { Tone } from "@/lib/tone";
import { PageHeader } from "@/components/ui/page-header";
import { BladeMain, OverviewLayout } from "@/components/ui/layouts";
import { Surface } from "@/components/ui/surface";
import { StatusBadge } from "@/components/ui/status";
import { Metric, MetricGrid } from "@/components/ui/metric";
import { EmptyState } from "@/components/ui/states";
import { compactTableFrameCls, compactTableCls, compactTheadRowCls, compactThCls, compactTdCls, compactRowCls } from "@/components/console-primitives";

export const dynamic = "force-dynamic";

const STATE: Record<JobState, { tone: Tone; label: string }> = {
  ok: { tone: "positive", label: "Running" },
  error: { tone: "critical", label: "Failing" },
  stale: { tone: "attention", label: "Stale" },
  never: { tone: "neutral", label: "No run yet" },
  not_configured: { tone: "neutral", label: "Not set up" },
  browser_pending: { tone: "info", label: "Auto-Pull" },
};

const when = (iso: string | null): string => {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", { timeZone: DISPLAY_TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
};

// Clock math lives outside render (the react-hooks/purity rule forbids Date.now() in a component body).
const clockNow = (): number => Date.now();
const daysSince = (iso: string): number => (iso ? Math.floor((Date.now() - Date.parse(iso)) / 86_400_000) : 0);

const ago = (iso: string | null, now: number): string => {
  if (!iso) return "";
  const m = Math.round((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(m) || m < 0) return "";
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};

function JobsTable({ jobs, now }: { jobs: RegisterJob[]; now: number }): React.JSX.Element {
  return (
    <div className={compactTableFrameCls}>
      <table className={compactTableCls}>
        <thead>
          <tr className={compactTheadRowCls}>
            <th className={compactThCls}>Job</th>
            <th className={`${compactThCls} whitespace-nowrap`}>Status</th>
            <th className={`${compactThCls} whitespace-nowrap`}>Last run</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.key} className={compactRowCls}>
              <td className={compactTdCls}>
                <div className="text-foreground">{j.label}</div>
                {j.lastDetail && <div className="mt-0.5 line-clamp-2 text-[11.5px] text-meta">{j.lastDetail}</div>}
              </td>
              <td className={`${compactTdCls} whitespace-nowrap`}>
                <StatusBadge tone={STATE[j.state].tone} size="sm">
                  {STATE[j.state].label}
                </StatusBadge>
              </td>
              <td className={`${compactTdCls} whitespace-nowrap tabular-nums`}>
                <div>{when(j.lastRunAt)}</div>
                {j.lastRunAt && <div className="text-[11px] text-meta">{ago(j.lastRunAt, now)}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Where a person goes to handle a suggestion. Internal blades open in the same tab, outside systems in a new one.
function recommendation(p: ObservedAction): { href: string; label: string; external: boolean } {
  if (p.actionType === "review_booking_gap") return { href: "/sales", label: "Review in Sales", external: false };
  switch (p.target) {
    case "dispatch":
      return { href: "/dispatch", label: "Open Dispatch", external: false };
    case "goodshuffle":
      return { href: "https://pro.goodshuffle.com", label: "Open Goodshuffle", external: true };
    case "connecteam":
      return { href: "https://app.connecteam.com", label: "Open Connecteam", external: true };
    default:
      return { href: "/risk", label: "Review in Event Risk", external: false };
  }
}

const TIER_LABEL: Record<Tier, string> = { observe: "Observe", recommend: "Recommend", prepare: "Prepare", approve: "Needs approval", auto: "Could run on its own" };
const TARGET_LABEL: Record<Target, string> = { dispatch: "Dispatch", connecteam: "Connecteam", goodshuffle: "Goodshuffle", slack: "Slack", internal: "Internal" };
const chip = "border border-border px-1.5 py-0.5 text-[10.5px] uppercase tracking-[0.06em] text-meta";

function SuggestionRow({ p }: { p: ObservedAction }): React.JSX.Element {
  const rec = recommendation(p);
  const days = daysSince(p.firstObservedAt);
  const btn = "inline-flex items-center gap-1.5 border border-border px-2.5 py-1 text-[12px] text-foreground hover:bg-row-hover";
  return (
    <div className="border-b border-rule/60 px-3 py-3 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className={chip}>{TIER_LABEL[p.tier]}</span>
        <span className={chip}>{TARGET_LABEL[p.target]}</span>
        {p.outward && (
          <StatusBadge tone="attention" size="sm">
            Touches customers
          </StatusBadge>
        )}
        <span className="ml-auto text-[11px] text-meta">{days <= 0 ? "first seen today" : `suggested for ${days}d`}</span>
      </div>
      <div className="mt-1.5 text-[13.5px] font-medium text-foreground">{p.title}</div>
      <p className="mt-0.5 text-[12.5px] text-secondary-text">{p.detail}</p>
      <div className="mt-2">
        {rec.external ? (
          <a href={rec.href} target="_blank" rel="noopener noreferrer" className={btn}>
            {rec.label} <ExternalLink className="size-3" />
          </a>
        ) : (
          <Link href={rec.href} className={btn}>
            {rec.label} <ArrowUpRight className="size-3" />
          </Link>
        )}
      </div>
    </div>
  );
}

function SectionTitle({ children, sub }: { children: React.ReactNode; sub?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mb-2">
      <h2 className="text-[15px] font-semibold text-foreground">{children}</h2>
      {sub && <p className="text-[12px] text-meta">{sub}</p>}
    </div>
  );
}

export default async function AutomationPage(): Promise<React.JSX.Element> {
  const role = await viewerRole();
  const showMoney = canSeeFinancials(role);
  const canDismiss = canManageSettings(role);
  const now = clockNow();
  const reg = automationRegister({ showMoney }, now);
  const suggestions = automationOverview();
  const jc = reg.jobCounts;
  const wb = reg.writeBacks;
  const needsPerson = wb.summary.deadLetter + wb.summary.legacyFailed + wb.summary.unhandled;
  const problems = jc.failing + jc.stale;
  const configured = jc.total - jc.notSetUp - jc.browser;

  const main = (
    <div className="space-y-6">
      <section>
        <SectionTitle sub="Server jobs run every 15 minutes. Each one does its own check on whether it has work to do.">Scheduled jobs</SectionTitle>
        <div className="space-y-4">
          {groupJobs(reg.jobs).map((g) => (
            <div key={g.area}>
              <div className="mb-1.5 text-[11px] uppercase tracking-[0.07em] text-meta">{g.area}</div>
              <JobsTable jobs={g.jobs} now={now} />
            </div>
          ))}
        </div>
      </section>

      <section>
        <SectionTitle sub="Changes the app makes in Goodshuffle. They wait here until Auto-Pull picks them up from a teammate's Chrome.">
          Goodshuffle write-backs
        </SectionTitle>
        <Surface pad="none">
          <div className="grid grid-cols-2 gap-px bg-rule sm:grid-cols-4">
            {[
              { label: "Waiting to send", value: wb.summary.due },
              { label: "Retrying later", value: wb.summary.waitingRetry },
              { label: "Need a person", value: needsPerson },
              { label: "Landed, last 7 days", value: wb.landedTotal },
            ].map((x) => (
              <div key={x.label} className="surface px-3 py-2.5">
                <div className="text-[11px] text-meta">{x.label}</div>
                <div className="mt-0.5 text-[16px] font-semibold tabular-nums">{x.value}</div>
              </div>
            ))}
          </div>
          {wb.summary.oldestDueAgeMs !== null && (
            <p className="border-t border-rule px-3 py-2 text-[12px] text-secondary-text">
              Oldest waiting change was queued {Math.round(wb.summary.oldestDueAgeMs / 3_600_000)}h ago.{" "}
              {wb.summary.lastLandedAgeMs !== null && wb.summary.lastLandedAgeMs < outboxThresholds().staleHours * 3_600_000
                ? "Other changes are landing, so Auto-Pull is running; see the stuck items below."
                : "If it keeps growing, make sure someone's Chrome with Auto-Pull is open and signed in to Goodshuffle."}
            </p>
          )}
          {wb.summary.unhandledOps.length > 0 && (
            <p className="border-t border-rule px-3 py-2 text-[12px] text-secondary-text">
              Nothing knows how to send: {wb.summary.unhandledOps.join(", ")}.
            </p>
          )}
          <WriteBacksNeedingPerson rows={wb.needsPerson} canDismiss={canDismiss} />
          {wb.landed7d.length > 0 && (
            <ul className="border-t border-rule">
              <li className="px-3 pt-2 text-[10.5px] uppercase tracking-[0.06em] text-meta">Landed in the last 7 days</li>
              {wb.landed7d.map((o) => (
                <li key={o.op} className="flex items-center justify-between border-b border-rule/60 px-3 py-1.5 text-[12.5px] last:border-0">
                  <span className="text-secondary-text">{o.label}</span>
                  <span className="tabular-nums text-foreground">{o.count}</span>
                </li>
              ))}
            </ul>
          )}
        </Surface>
      </section>

      <section>
        <SectionTitle sub="Built from live risks and empty booking weeks. These never run: each one links to where you act.">
          Suggestions for a person ({suggestions.total})
        </SectionTitle>
        {suggestions.total === 0 ? (
          <EmptyState title="Nothing to suggest right now" body="No open risk has a recommended action, and no near-term week is empty." />
        ) : (
          <Surface pad="none">
            {suggestions.proposals.map((p) => (
              <SuggestionRow key={p.key} p={p} />
            ))}
          </Surface>
        )}
      </section>
    </div>
  );

  const context = (
    <>
      <Surface pad="md" className="space-y-3">
        <div className="text-[11px] uppercase tracking-[0.07em] text-meta">On/off switches</div>
        <ul className="space-y-2.5">
          {reg.switches.map((s) => (
            <li key={s.env}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12.5px] text-foreground">{s.label}</span>
                <StatusBadge tone={s.on ? "positive" : "neutral"} size="sm">
                  {s.on ? "On" : "Off"}
                </StatusBadge>
              </div>
              <p className="mt-0.5 text-[11.5px] text-meta">{s.controls}</p>
            </li>
          ))}
        </ul>
        <p className="border-t border-rule pt-2 text-[11.5px] text-meta">
          Every switch is on unless its Fly secret is set to false, for example <code className="text-secondary-text">SMS_SEND_ENABLED=false</code>.
        </p>
      </Surface>

      <Surface pad="md" className="space-y-1.5">
        <div className="text-[11px] uppercase tracking-[0.07em] text-meta">AI approvals</div>
        <p className="text-[12.5px] text-secondary-text">
          <b className="text-foreground">{reg.approvals.waiting}</b> waiting on a person. Last 7 days: {reg.approvals.executed7d} approved and queued,{" "}
          {reg.approvals.held7d} approved but held, {reg.approvals.rejected7d} rejected
          {reg.approvals.failed7d > 0 ? `, ${reg.approvals.failed7d} failed` : ""}.
        </p>
        <Link href="/ai-org/approvals" className="inline-flex items-center gap-1 text-[12px] text-foreground hover:underline">
          Open approvals <ArrowUpRight className="size-3" />
        </Link>
      </Surface>

      <Surface pad="md" className="space-y-1.5">
        <div className="text-[11px] uppercase tracking-[0.07em] text-meta">What is not here</div>
        <p className="text-[11.5px] leading-relaxed text-meta">
          Event triggered actions (the texts drivers set off, lead intake, Slack alerts) run when their event happens, not on a
          schedule, so they show only as switches.
        </p>
      </Surface>
    </>
  );

  return (
    <BladeMain>
      <PageHeader
        title="Automation"
        icon={<Workflow className="size-6" />}
        subtitle="What the platform does on its own, and what it suggests a person do"
      />

      <MetricGrid className="mb-4 lg:grid-cols-4">
        <Metric
          label="Jobs running"
          value={`${jc.running} of ${configured}`}
          sub={jc.notSetUp > 0 ? `${jc.notSetUp} not set up` : "all set up"}
          tone={problems > 0 ? "attention" : "positive"}
        />
        <Metric label="Failing or stale" value={problems} sub={problems > 0 ? "see the list below" : "none"} tone={problems > 0 ? "critical" : "positive"} />
        <Metric label="Write-backs waiting" value={wb.summary.due} sub={needsPerson > 0 ? `${needsPerson} need a person` : `${wb.landedTotal} landed this week`} tone={needsPerson > 0 ? "critical" : undefined} />
        <Metric label="Approvals waiting" value={reg.approvals.waiting} sub="AI drafts a person must decide" tone={reg.approvals.waiting > 0 ? "attention" : undefined} />
      </MetricGrid>

      <OverviewLayout main={main} context={context} />
    </BladeMain>
  );
}
