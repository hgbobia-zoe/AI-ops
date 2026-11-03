// People Lifecycle — onboarding & offboarding command surface. Owner/admin only (canManageUsers; the
// proxy also gates /people). A blade-local vertical section nav (PeopleSubnav) replaces the old
// horizontal tab row; the four sections preserve the existing `?tab=` deep links: Onboarding ·
// Offboarding · Access Policies · Activity.
//
// FACTS ONLY — statuses, systems and modes come from the access-policy config + the lifecycle tasks,
// never hard-coded. Only the Zoe platform login is automated; every other system is a tracked manual
// step, and OFFBOARDED does NOT mean access was removed. RULES CALCULATE (the engine); this renders.

import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Contact, UserPlus, LogOut, ArrowRight, Wallet, Search,
} from "lucide-react";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageUsers } from "@/lib/auth/roles";
import { PageHeader } from "@/components/ui/page-header";
import { Surface } from "@/components/ui/surface";
import { Metric, MetricGrid } from "@/components/ui/metric";
import { StatusBadge } from "@/components/ui/status";
import { EmptyState, StatusBanner } from "@/components/ui/states";
import { peopleOverview, lifecycleList, type EmployeeSummary } from "@/lib/people/overview";
import { listPolicies } from "@/lib/people/store";
import { getRecentAudit } from "@/lib/db/repo";
import {
  STAGE_META, ONBOARDING_STAGES, OFFBOARDING_STAGES, type Stage,
} from "@/lib/people/stages";
import { filterPeople, parseStageFilter, stageCounts, type StageFilter } from "@/lib/people/list";
import { ADAPTER_LABEL } from "@/lib/people/policy";
import type { AdapterMode } from "@/lib/people/types";
import { policyIssuesWorkEmail } from "@/lib/people/policy";
import { AddEmployeeDialog } from "@/components/people/AddEmployeeDialog";
import { PeopleSubnav, type PeopleTab } from "@/components/people/PeopleSubnav";
import { getAdapter } from "@/lib/people/adapters";
import { connecteamScopeStatus } from "@/lib/people/connecteamScope";
import { lastMatchReport, type MatchReport } from "@/lib/people/matchRun";
import type { MatchException } from "@/lib/people/match";
import { RunMatchButton, ConfirmLinkButton, VerifyConnecteamButton } from "@/components/people/PeopleControls";

export const dynamic = "force-dynamic";

const TABS: PeopleTab[] = ["onboarding", "offboarding", "matching", "policies", "activity"];
const MODE_LABEL: Record<AdapterMode, string> = { automated: "Automated", partial: "Partial", manual: "Manual", future: "Future" };
const MODE_TONE: Record<AdapterMode, "positive" | "attention" | "neutral"> = { automated: "positive", partial: "attention", manual: "neutral", future: "neutral" };

export default async function PeoplePage({ searchParams }: { searchParams: Promise<{ tab?: string; stage?: string; q?: string }> }): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canManageUsers(role)) redirect("/dashboard");
  const sp = await searchParams;
  const tab: PeopleTab = (TABS.includes(sp.tab as PeopleTab) ? sp.tab : "onboarding") as PeopleTab;

  const ov = peopleOverview();
  const policies = listPolicies();
  const policyOptions = policies.map((p) => ({ id: p.id, name: p.name, issuesEmail: policyIssuesWorkEmail(p) }));

  return (
    <div className="flex flex-col lg:flex-row lg:items-start">
      <PeopleSubnav activeTab={tab} />
      <main className="mx-auto w-full min-w-0 max-w-[1240px] flex-1 p-3 pb-12 leading-[1.35] md:p-5">
        <PageHeader
          title="People Lifecycle"
          icon={<Contact className="size-5" />}
          subtitle="Onboarding and offboarding with honest, audited access provisioning."
          actions={tab === "onboarding" ? <AddEmployeeDialog policies={policyOptions} /> : undefined}
        />

        {/* Scope clarification — this registry is NOT the payroll worker directory. */}
        <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-meta">
          <span>Tracks the onboarding/offboarding lifecycle for {ov.counts.total} {ov.counts.total === 1 ? "person" : "people"}.</span>
          <span className="inline-flex items-center gap-1">
            Pay and the worker directory live in
            <Link href="/payroll" className="inline-flex items-center gap-1 text-tertiary-text underline-offset-2 hover:text-foreground hover:underline">
              <Wallet className="size-3.5" aria-hidden /> HR / Payroll
            </Link>.
          </span>
        </div>

        <MetricGrid className="mb-6">
          <Metric label="People" value={ov.counts.total} />
          <Metric label="Active" value={ov.counts.active} tone={ov.counts.active > 0 ? "positive" : "neutral"} sub={ov.counts.active > 0 ? "fully onboarded" : "none yet"} />
          <Metric label="Onboarding" value={ov.counts.onboarding} tone={ov.counts.onboarding > 0 ? "attention" : "neutral"} sub="in progress" />
          <Metric label="Offboarding" value={ov.counts.offboarding} sub="in progress + done" />
          <Metric label="Open access revokes" value={ov.counts.outstandingRevokes} tone={ov.counts.outstandingRevokes > 0 ? "attention" : "neutral"} sub={ov.counts.outstandingRevokes > 0 ? "awaiting confirmation" : "all confirmed"} />
        </MetricGrid>

        {tab !== "matching" && <MatchBanner report={lastMatchReport()} />}
        {tab === "onboarding" && <OnboardingTab stage={sp.stage} q={sp.q} policies={policyOptions} />}
        {tab === "offboarding" && <OffboardingTab stage={sp.stage} q={sp.q} />}
        {tab === "matching" && <MatchingTab report={lastMatchReport()} />}
        {tab === "policies" && <PoliciesTab policies={policies} />}
        {tab === "activity" && <ActivityTab />}
      </main>
    </div>
  );
}

// ══ ONBOARDING — the unified, searchable/filterable lifecycle list ══════════════════════════════════════
function OnboardingTab({ stage, q, policies }: { stage?: string; q?: string; policies: { id: string; name: string; issuesEmail?: boolean }[] }): React.JSX.Element {
  const scope = lifecycleList().filter((p) => STAGE_META[p.stage].group === "onboarding");
  const active = parseStageFilter(stage, ONBOARDING_STAGES);
  const query = (q ?? "").trim();
  const counts = stageCounts(scope, ONBOARDING_STAGES);
  const rows = filterPeople(scope, { stage: active, q: query });

  if (scope.length === 0) {
    return (
      <EmptyState
        icon={<UserPlus className="size-6" />}
        title="No one in the onboarding lifecycle yet"
        body="Add an employee to create their lifecycle record and provisioning checklist. This registry is separate from the Connecteam-sourced payroll directory."
        action={<AddEmployeeDialog policies={policies} />}
      />
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <FilterBar tab="onboarding" stages={ONBOARDING_STAGES} active={active} counts={counts} q={query} />
      <PeopleList rows={rows} emptyLabel={query || active !== "all" ? "No people match this filter." : "No people in the onboarding lifecycle."} />
    </section>
  );
}

// ══ OFFBOARDING — in-progress + done, with honest revoke priorities ═════════════════════════════════════
function OffboardingTab({ stage, q }: { stage?: string; q?: string }): React.JSX.Element {
  const scope = lifecycleList().filter((p) => STAGE_META[p.stage].group === "offboarding");
  const active = parseStageFilter(stage, OFFBOARDING_STAGES);
  const query = (q ?? "").trim();
  const counts = stageCounts(scope, OFFBOARDING_STAGES);
  const rows = filterPeople(scope, { stage: active, q: query });
  const openRevokes = scope.reduce((n, s) => n + s.outstandingRevokes, 0);

  return (
    <section className="flex flex-col gap-4">
      <StatusBanner tone={openRevokes > 0 ? "attention" : "neutral"} title="OFFBOARDED does not mean access was removed">
        Marking someone offboarded completes the HR process only. Manual access revokes stay open and escalating until a
        human confirms each one in the external system.{openRevokes > 0 ? ` ${openRevokes} revoke${openRevokes === 1 ? "" : "s"} still open across this list.` : " No open revokes right now."}
      </StatusBanner>

      {scope.length === 0 ? (
        <EmptyState icon={<LogOut className="size-6" />} title="No one offboarding" body="People being offboarded, and completed offboardings with any still-open access revokes, appear here." />
      ) : (
        <>
          <FilterBar tab="offboarding" stages={OFFBOARDING_STAGES} active={active} counts={counts} q={query} />
          <PeopleList rows={rows} showRevokes emptyLabel={query || active !== "all" ? "No people match this filter." : "No one offboarding."} />
        </>
      )}
    </section>
  );
}

// ── Filter bar: stage chips (with counts) + a GET search form (server-rendered filter, deep-linkable) ──
function FilterBar({ tab, stages, active, counts, q }: {
  tab: PeopleTab; stages: Stage[]; active: StageFilter; counts: { all: number } & Partial<Record<Stage, number>>; q: string;
}): React.JSX.Element {
  const chipHref = (s: StageFilter): string => {
    const params = new URLSearchParams({ tab });
    if (s !== "all") params.set("stage", s);
    if (q) params.set("q", q);
    return `/people?${params.toString()}`;
  };
  const chipCls = (on: boolean): string =>
    `rounded-md border px-2.5 py-1 text-[11.5px] transition-colors ${on ? "border-foreground/30 bg-foreground/[0.08] text-foreground" : "border-border text-meta hover:text-foreground"}`;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap gap-1">
        <Link href={chipHref("all")} aria-current={active === "all" ? "true" : undefined} className={chipCls(active === "all")}>
          All <span className="tabular-nums text-meta">({counts.all})</span>
        </Link>
        {stages.map((s) => (
          <Link key={s} href={chipHref(s)} aria-current={active === s ? "true" : undefined} className={chipCls(active === s)} title={STAGE_META[s].hint}>
            {STAGE_META[s].label} <span className="tabular-nums text-meta">({counts[s] ?? 0})</span>
          </Link>
        ))}
      </div>
      <form className="ml-auto flex items-center gap-1.5 rounded-md border border-border px-2 py-1" action="/people">
        <input type="hidden" name="tab" value={tab} />
        {active !== "all" && <input type="hidden" name="stage" value={active} />}
        <Search className="size-3.5 text-meta" aria-hidden />
        <input name="q" defaultValue={q} placeholder="Search people" aria-label="Search people" className="w-36 bg-transparent text-[12px] text-foreground outline-none placeholder:text-meta" />
      </form>
    </div>
  );
}

// ── The lifecycle list — one responsive list of person rows (no five empty panels) ──────────────────────
function PeopleList({ rows, showRevokes, emptyLabel }: { rows: EmployeeSummary[]; showRevokes?: boolean; emptyLabel: string }): React.JSX.Element {
  if (rows.length === 0) {
    return <Surface className="px-4 py-10 text-center text-[12.5px] text-meta">{emptyLabel}</Surface>;
  }
  return (
    <Surface pad="none" className="divide-y divide-[var(--row-rule)] overflow-hidden">
      {rows.map((s) => <PersonRow key={s.employee.id} s={s} showRevokes={showRevokes} />)}
    </Surface>
  );
}

function PersonRow({ s, showRevokes }: { s: EmployeeSummary; showRevokes?: boolean }): React.JSX.Element {
  const e = s.employee;
  const meta = STAGE_META[s.stage];
  const isOnboarding = e.lifecycleState === "ONBOARD";
  const r = s.readiness;
  return (
    <Link href={`/people/${e.id}`} className="flex items-center gap-3 px-3.5 py-3 transition-colors hover:bg-[var(--row-hover)]">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-medium text-foreground">{e.displayName}</div>
        <div className="mt-0.5 truncate text-[11.5px] text-meta">
          <span className="capitalize">{e.role}</span> · {e.department ?? "no policy"}
          {e.startDate && <span> · starts {e.startDate}</span>}
          {e.endDate && <span className="text-attention"> · ends {e.endDate}</span>}
        </div>
      </div>

      {/* Onboarding progress — required-completion + blocker count, honest (never "provisioned" from a box) */}
      {isOnboarding && (
        <div className="hidden w-40 shrink-0 sm:block">
          <div className="flex items-center justify-between text-[11px] text-meta">
            <span className="tabular-nums">{r.completed}/{r.totalRequired} required</span>
            <span className="tabular-nums">{r.completionPct}%</span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-[var(--row)]">
            <div className="h-full bg-foreground/55" style={{ width: `${r.completionPct}%` }} />
          </div>
        </div>
      )}

      {/* Offboarding — open-revoke priority */}
      {showRevokes && (
        <div className="hidden w-40 shrink-0 text-right sm:block">
          {s.outstandingRevokes > 0
            ? <StatusBadge tone="attention" size="sm">{s.outstandingRevokes} revoke{s.outstandingRevokes === 1 ? "" : "s"} open</StatusBadge>
            : <StatusBadge tone="positive" size="sm">All access revoked</StatusBadge>}
        </div>
      )}

      <div className="w-28 shrink-0 text-right sm:w-32">
        <StatusBadge tone={meta.tone} size="sm" className="justify-end">{meta.label}</StatusBadge>
      </div>
      <ArrowRight className="size-4 shrink-0 text-meta" aria-hidden />
    </Link>
  );
}

// ══ ACCESS POLICIES ═════════════════════════════════════════════════════════════════════════════════════
function PoliciesTab({ policies }: { policies: ReturnType<typeof listPolicies> }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[12px] text-meta">
        Seeded, config-driven policies. Each mode is what the app can really do today for that system.
        Only <span className="text-foreground">Automated</span> steps can be executed in-app; the rest are tracked manual steps. Editing is read-only in this phase.
      </p>
      <ConnecteamCard />
      {policies.map((p) => (
        <Surface key={p.id} aria-labelledby={`policy-${p.id}`}>
          <h3 id={`policy-${p.id}`} className="mb-2.5 flex items-center gap-2 text-[14px] font-medium text-foreground">
            {p.name}
            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.06em] text-meta">{p.seeded ? "seeded" : "custom"}</span>
          </h3>
          <ul className="grid gap-px overflow-hidden rounded border border-border bg-border sm:grid-cols-2">
            {p.rules.map((rr) => (
              <li key={rr.adapterId} className="flex items-center justify-between gap-2 bg-[var(--panel)] px-3 py-2">
                <span className="min-w-0 text-[13px] text-foreground">
                  <span className="truncate">{ADAPTER_LABEL[rr.adapterId] ?? rr.system}</span>
                  {rr.required && <span className="ml-1.5 text-[10px] uppercase tracking-[0.05em] text-meta">required</span>}
                </span>
                <StatusBadge tone={MODE_TONE[getAdapter(rr.adapterId).mode()]} size="sm">{MODE_LABEL[getAdapter(rr.adapterId).mode()]}</StatusBadge>
              </li>
            ))}
          </ul>
        </Surface>
      ))}
    </div>
  );
}

// ══ ACTIVITY ════════════════════════════════════════════════════════════════════════════════════════════
function ActivityTab(): React.JSX.Element {
  const rows = getRecentAudit(["ONBOARDING_STARTED", "MARKED_READY", "ACTIVATED", "OFFBOARDING_STARTED", "OFFBOARDED", "ACCESS_GRANTED", "ACCESS_REVOKED", "TASK_RETRIED", "TASK_SKIPPED", "EMPLOYEE_IMPORTED", "IDENTITY_LINKED", "PHONE_SET", "POLICY_SET", "SOP_SIGNED", "CONNECTEAM_SCOPE_VERIFIED", "CONNECTEAM_SCOPE_CHECK_FAILED", "CONNECTEAM_SCOPE_CLEARED"], 80);
  if (rows.length === 0) {
    return <EmptyState title="No lifecycle activity yet" body="Onboarding, access grants/revokes, activations and offboardings are recorded here with who did them." />;
  }
  return (
    <Surface pad="none" className="divide-y divide-[var(--row-rule)] overflow-hidden">
      {rows.map((r) => (
        <div key={r.auditId} className="flex items-center justify-between gap-3 px-4 py-2.5">
          <div className="min-w-0">
            <span className="text-[12.5px] font-medium text-foreground">{r.action.replace(/_/g, " ").toLowerCase()}</span>
            <span className="ml-2 text-[11.5px] text-meta">{r.entityId}</span>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-[11.5px] text-secondary-text">{r.actor}</div>
            <div className="text-[10.5px] text-meta">{new Date(r.ts).toLocaleString()}</div>
          </div>
        </div>
      ))}
    </Surface>
  );
}

// ══ MATCHING — existing staff tied to People records, and what could not be matched ═══════════════════
const EXCEPTION_LABEL: Record<MatchException["kind"], string> = {
  ambiguous: "Two or more possible people",
  probable: "Probable match, needs a yes",
  no_match: "No People record",
  new_in_connecteam: "New in Connecteam",
  missing_in_connecteam: "Not linked to Connecteam",
  no_policy: "No access policy",
};
const SYSTEM_LABEL: Record<MatchException["system"], string> = { connecteam: "Connecteam", zoe: "Zoe login", payroll: "Payroll", people: "People" };

function MatchBanner({ report }: { report: MatchReport | null }): React.JSX.Element | null {
  const n = report?.exceptions.length ?? 0;
  if (n === 0) return null;
  return (
    <StatusBanner
      tone="attention"
      title={`${n} account${n === 1 ? "" : "s"} could not be matched to a person`}
      className="mb-5"
      action={<Link href="/people?tab=matching" className="text-[12px] text-foreground underline-offset-2 hover:underline">Review</Link>}
    >
      Until they are matched, offboarding someone may miss these accounts.
    </StatusBanner>
  );
}

function MatchingTab({ report }: { report: MatchReport | null }): React.JSX.Element {
  return (
    <section className="flex flex-col gap-4">
      <Surface>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 text-[12.5px] text-secondary-text">
            <p>
              Ties everyone who already works here to a People record, across Connecteam, Zoe logins and payroll, so offboarding
              anyone has real accounts to act on. It links only on an exact id, phone, email or full name, never overwrites a
              link, and lists everything else below. It runs every 15 minutes.
            </p>
            <p className="mt-1.5 text-meta">
              {report
                ? <>Last run {new Date(report.ranAt).toLocaleString()} by {report.by ?? "the scheduled job"}: {report.created.length} added, {report.linked.length} linked, {report.exceptions.length} to sort out.{report.rosterOk ? "" : " Connecteam did not answer, so roster checks were skipped."}</>
                : "Not run yet."}
            </p>
          </div>
          <RunMatchButton />
        </div>
      </Surface>

      {report && report.created.length > 0 && (
        <Surface>
          <h3 className="mb-2 text-[13px] font-medium text-foreground">Added as existing staff on the last run</h3>
          <ul className="flex flex-wrap gap-2 text-[12px]">
            {report.created.map((c) => (
              <li key={c.employeeId}>
                <Link href={`/people/${c.employeeId}`} className="rounded border border-border px-2 py-0.5 text-secondary-text hover:text-foreground">{c.name}</Link>
              </li>
            ))}
          </ul>
        </Surface>
      )}

      {!report || report.exceptions.length === 0 ? (
        <EmptyState
          title={report ? "Everyone is matched" : "Matching has not run yet"}
          body={report ? "Every account found is tied to a person." : "Press Match now, or wait for the next scheduled run."}
        />
      ) : (
        <Surface pad="none" className="divide-y divide-[var(--row-rule)] overflow-hidden">
          {report.exceptions.map((x) => (
            <div key={x.key} className="flex flex-wrap items-start justify-between gap-3 px-3.5 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium text-foreground">{x.subject}</span>
                  <StatusBadge tone={x.kind === "probable" ? "info" : "attention"} size="sm">{EXCEPTION_LABEL[x.kind]}</StatusBadge>
                  <span className="text-[11px] text-meta">{SYSTEM_LABEL[x.system]}</span>
                </div>
                <p className="mt-0.5 text-[12px] text-secondary-text">{x.detail}</p>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                {x.suggestions.map((sg) => (
                  <ConfirmLinkButton key={`${sg.employeeId}:${sg.field}`} employeeId={sg.employeeId} employeeName={sg.employeeName} field={sg.field} value={sg.value} />
                ))}
                {x.employeeId && (
                  <Link href={`/people/${x.employeeId}`} className="text-[12px] text-meta underline-offset-2 hover:text-foreground hover:underline">Open person</Link>
                )}
              </div>
            </div>
          ))}
        </Surface>
      )}
    </section>
  );
}

function ConnecteamCard(): React.JSX.Element {
  const st = connecteamScopeStatus();
  return (
    <Surface aria-labelledby="ct-scope-h">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 id="ct-scope-h" className="flex items-center gap-2 text-[14px] font-medium text-foreground">
            Connecteam
            <StatusBadge tone={st.verified ? "positive" : "neutral"} size="sm">{st.verified ? "Automated" : "Manual"}</StatusBadge>
          </h3>
          <p className="mt-1 text-[12px] text-secondary-text">
            {!st.configured
              ? "No Connecteam API key is set, so Connecteam steps stay manual."
              : st.verified
                ? "Write access is verified. Approving a Connecteam step creates the user (no activation text) and offboarding archives them."
                : "Check that the API key can create users. The check creates nobody. If it passes, Connecteam steps run from People after you approve them."}
          </p>
          {st.last && (
            <p className="mt-1 text-[11.5px] text-meta">
              Last check {new Date(st.last.checkedAt).toLocaleString()} by {st.last.by}: {st.last.detail}.
            </p>
          )}
        </div>
        {st.configured && <VerifyConnecteamButton verified={st.verified} />}
      </div>
    </Surface>
  );
}
