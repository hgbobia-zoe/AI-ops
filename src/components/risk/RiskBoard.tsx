"use client";

// The /risk work surface: a scannable, filterable risk table where every row shows severity, the
// issue, the affected date/event/route (day-level risks read as an operational date, never a specific
// event), the lifecycle state, the owner, and ONE promoted next action. Secondary lifecycle actions
// live in an accessible overflow menu; Resolve/Dismiss require a confirm step. Expanding a row reveals
// full evidence, source, affected records, the recommended action, and the risk's own audit history.
//
// The server (api/risk/status) is the only authority for a status change and the only thing that
// writes the audit log — this component just offers the valid actions and refreshes after. Following an
// external resolution link NEVER changes a risk's state.

import { Fragment, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  MoreHorizontal,
  CircleCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { StatusBadge } from "@/components/ui/status";
import { EmptyState } from "@/components/ui/states";
import { Provenance } from "@/components/console-primitives";
import { formatYmdLong } from "@/lib/dates";
import type { StoredRisk } from "@/lib/risk/store";
import type { RiskStatus, RiskSeverity } from "@/lib/risk/types";
import type { ChangeRow } from "@/lib/history/store";
import {
  severityTone,
  statusTone,
  SEVERITY_LABEL,
  STATUS_LABEL_TEXT,
  affectedScope,
  scopeKindLabel,
  sourceLabel,
  resolutionTarget,
  isUnverified,
  nextAction,
  overflowActions,
  filterRisks,
  daysUntilLabel,
  relTime,
  type RiskAction,
  type SeverityFilter,
  type StateFilter,
  type FreshnessFilter,
} from "@/lib/risk/present";

const SEVERITIES: SeverityFilter[] = ["ALL", "CRITICAL", "HIGH", "MEDIUM", "LOW"];
const STATES: StateFilter[] = ["ALL", "OPEN", "ACKNOWLEDGED", "IN_PROGRESS"];
const FRESHNESS: FreshnessFilter[] = ["ALL", "VERIFIED", "UNVERIFIED"];
const STATE_FILTER_LABEL: Record<StateFilter, string> = {
  ALL: "All states",
  OPEN: "Open",
  ACKNOWLEDGED: "Acknowledged",
  IN_PROGRESS: "In progress",
  RESOLVED: "Resolved",
  DISMISSED: "Dismissed",
};
const FRESHNESS_LABEL: Record<FreshnessFilter, string> = {
  ALL: "All sources",
  VERIFIED: "Verified only",
  UNVERIFIED: "Unverified only",
};

/** Build a context-carrying resolution href when the destination supports it (never invented): the
 *  dispatch board accepts ?date=YYYY-MM-DD, so a dated risk jumps to that day. External bases stay as-is. */
function resolutionHref(r: StoredRisk): { label: string; href: string; external: boolean } | undefined {
  const t = resolutionTarget(r.actionTarget);
  if (!t) return undefined;
  if (r.actionTarget === "dispatch" && r.date) return { ...t, href: `/dispatch?date=${r.date}` };
  return t;
}

export function RiskBoard({
  risks,
  history,
  today,
  evaluatedAt,
}: {
  risks: StoredRisk[];
  history: Record<string, ChangeRow[]>;
  today: string;
  evaluatedAt: string | null;
}): React.JSX.Element {
  const router = useRouter();
  const [severity, setSeverity] = useState<SeverityFilter>("ALL");
  const [state, setState] = useState<StateFilter>("ALL");
  const [freshness, setFreshness] = useState<FreshnessFilter>("ALL");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ risk: StoredRisk; action: RiskAction } | null>(null);

  const filtered = useMemo(
    () => filterRisks(risks, { severity, state, freshness }),
    [risks, severity, state, freshness],
  );

  async function apply(id: string, status: RiskStatus): Promise<void> {
    setBusyId(id);
    try {
      const res = await fetch("/api/risk/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      if (res.ok) router.refresh();
    } finally {
      setBusyId(null);
      setConfirm(null);
    }
  }

  function onAction(risk: StoredRisk, action: RiskAction): void {
    if (action.confirm) setConfirm({ risk, action });
    else void apply(risk.id, action.status);
  }

  function toggle(id: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const unverifiedCount = risks.filter(isUnverified).length;

  return (
    <div className="space-y-3">
      {/* Filters + freshness */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center rounded-lg border border-border p-0.5" role="group" aria-label="Filter by severity">
            {SEVERITIES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSeverity(s)}
                aria-pressed={severity === s}
                className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                  severity === s ? "bg-row text-foreground" : "text-meta hover:text-foreground"
                }`}
              >
                {s === "ALL" ? "All" : SEVERITY_LABEL[s as RiskSeverity]}
              </button>
            ))}
          </div>
          <FilterSelect label="State" value={state} onChange={(v) => setState(v as StateFilter)} options={STATES} render={(o) => STATE_FILTER_LABEL[o as StateFilter]} />
          <FilterSelect label="Source" value={freshness} onChange={(v) => setFreshness(v as FreshnessFilter)} options={FRESHNESS} render={(o) => FRESHNESS_LABEL[o as FreshnessFilter]} />
        </div>
        <div className="flex items-center gap-3 text-[11.5px] text-meta">
          <span>
            Showing <span className="tabular-nums text-tertiary-text">{filtered.length}</span> of{" "}
            <span className="tabular-nums text-tertiary-text">{risks.length}</span>
          </span>
          {evaluatedAt && <span>· Evaluated {relTime(evaluatedAt)}</span>}
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={risks.length === 0 ? "No open risks in the evaluation horizon" : "No risks match these filters"}
          body={
            risks.length === 0
              ? "Every scored route and operational date in the next 14 days is clear. New risks appear here as the engine detects them."
              : "Adjust the severity, state, or source filters to see more."
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[820px] border-collapse text-[13px]">
            <colgroup>
              <col style={{ width: "132px" }} />
              <col />
              <col style={{ width: "184px" }} />
              <col style={{ width: "140px" }} />
              <col style={{ width: "132px" }} />
              <col style={{ width: "176px" }} />
            </colgroup>
            <thead>
              <tr className="border-b border-rule text-left text-[10.5px] uppercase tracking-[0.06em] text-meta">
                <th className="px-3 py-2 font-medium">Severity</th>
                <th className="px-3 py-2 font-medium">Issue</th>
                <th className="px-3 py-2 font-medium">Affected</th>
                <th className="px-3 py-2 font-medium">State</th>
                <th className="px-3 py-2 font-medium">Owner</th>
                <th className="px-3 py-2 font-medium">Next action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const isOpen = expanded.has(r.id);
                const scope = affectedScope(r);
                const next = nextAction(r.status);
                const overflow = overflowActions(r.status);
                const link = resolutionHref(r);
                const unver = isUnverified(r);
                return (
                  <Fragment key={r.id}>
                    <tr
                      className={`border-b border-rule/60 align-top last:border-0 hover:bg-row-hover ${
                        r.severity === "CRITICAL" ? "border-l-2 border-l-status-blocked" : ""
                      }`}
                    >
                      <td className="px-3 py-2.5">
                        <StatusBadge tone={severityTone(r.severity)} size="sm">
                          {SEVERITY_LABEL[r.severity]}
                        </StatusBadge>
                      </td>
                      <td className="px-3 py-2.5">
                        <button
                          type="button"
                          onClick={() => toggle(r.id)}
                          aria-expanded={isOpen}
                          className="flex items-start gap-1.5 text-left"
                        >
                          <span className="mt-0.5 shrink-0 text-meta">
                            {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                          </span>
                          <span className="min-w-0">
                            <span className="block font-medium text-foreground">{r.title}</span>
                            <span className="mt-0.5 block text-[11.5px] text-meta">
                              {r.category}
                              {unver && <span className="text-status-warning"> · unverified source</span>}
                            </span>
                          </span>
                        </button>
                      </td>
                      <td className="px-3 py-2.5 text-[12.5px]">
                        {r.date ? (
                          <>
                            <span className="block tabular-nums text-tertiary-text">{formatYmdLong(r.date)}</span>
                            <span className="mt-0.5 block text-[11.5px] text-meta">
                              {scopeKindLabel(scope)} · {daysUntilLabel(r.date, today)}
                            </span>
                          </>
                        ) : (
                          <span className="text-meta">{scopeKindLabel(scope)}</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <StatusBadge tone={statusTone(r.status)} size="sm">
                          {STATUS_LABEL_TEXT[r.status]}
                        </StatusBadge>
                      </td>
                      <td className="px-3 py-2.5 text-[12.5px] text-tertiary-text">
                        {r.owner || <span className="text-meta">Unassigned</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1.5">
                          {next ? (
                            <Button size="xs" variant="outline" disabled={busyId === r.id} onClick={() => onAction(r, next)}>
                              {next.label}
                            </Button>
                          ) : (
                            <span className="text-[11.5px] text-meta">{STATUS_LABEL_TEXT[r.status]}</span>
                          )}
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              className="inline-flex size-6 items-center justify-center rounded-md border border-border text-meta transition-colors hover:bg-row-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                              aria-label="More actions"
                              disabled={busyId === r.id}
                            >
                              <MoreHorizontal className="size-3.5" />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="min-w-44">
                              {overflow.map((a) => (
                                <DropdownMenuItem key={a.status} onClick={() => onAction(r, a)}>
                                  {a.label}
                                </DropdownMenuItem>
                              ))}
                              <DropdownMenuItem onClick={() => toggle(r.id)}>
                                {isOpen ? "Hide details" : "View details"}
                              </DropdownMenuItem>
                              {link && (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    render={
                                      link.external ? (
                                        <a href={link.href} target="_blank" rel="noopener noreferrer" />
                                      ) : (
                                        <Link href={link.href} />
                                      )
                                    }
                                  >
                                    {link.label}
                                    {link.external && <ExternalLink className="ml-auto size-3.5" />}
                                  </DropdownMenuItem>
                                </>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-rule/60 last:border-0">
                        <td colSpan={6} className="bg-row px-3 py-3">
                          <RiskDetail risk={r} scope={scope} link={link} history={history[r.signature] ?? []} today={today} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {unverifiedCount > 0 && freshness !== "UNVERIFIED" && (
        <p className="text-[11.5px] text-meta">
          {unverifiedCount} risk{unverifiedCount === 1 ? "" : "s"} could not be verified against their source. Use the Source filter to isolate them.
        </p>
      )}

      {/* Confirm step for the closing (Resolve / Dismiss) actions */}
      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm?.action.label} this risk?</DialogTitle>
            <DialogDescription>
              {confirm?.action.status === "RESOLVED"
                ? "Mark this risk resolved. This records an audit entry and removes it from the active board. It will reappear if the underlying condition returns on the next scan."
                : "Dismiss this risk. It stays dismissed while the condition is unchanged, and a genuine worsening will resurface it. This records an audit entry."}
            </DialogDescription>
          </DialogHeader>
          {confirm && (
            <div className="rounded-md border border-border bg-panel px-3 py-2 text-[12.5px]">
              <div className="font-medium text-foreground">{confirm.risk.title}</div>
              <div className="mt-0.5 text-[11.5px] text-meta">
                {SEVERITY_LABEL[confirm.risk.severity]} · {confirm.risk.date ? formatYmdLong(confirm.risk.date) : "no date"}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant={confirm?.action.status === "RESOLVED" ? "default" : "destructive"}
              disabled={busyId !== null}
              onClick={() => confirm && apply(confirm.risk.id, confirm.action.status)}
            >
              <CircleCheck className="size-3.5" /> {confirm?.action.label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  render,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  render: (o: string) => string;
}): React.JSX.Element {
  return (
    <label className="inline-flex items-center gap-1.5 text-[11.5px] text-meta">
      <span className="sr-only sm:not-sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-input bg-background px-2 py-1 text-[12px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={label}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {render(o)}
          </option>
        ))}
      </select>
    </label>
  );
}

function RiskDetail({
  risk,
  scope,
  link,
  history,
  today,
}: {
  risk: StoredRisk;
  scope: ReturnType<typeof affectedScope>;
  link: { label: string; href: string; external: boolean } | undefined;
  history: ChangeRow[];
  today: string;
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <div className="space-y-3">
        <Field label="Evidence">
          <p className="text-[12.5px] text-secondary-text">{risk.description || "—"}</p>
          {isUnverified(risk) && (
            <p className="mt-1 text-[11.5px] text-status-warning">
              This check could not be verified against its source — treat as unknown, not confirmed clear.
            </p>
          )}
        </Field>
        <Field label="Recommended action">
          <p className="text-[12.5px] text-secondary-text">{risk.recommendedAction || "—"}</p>
        </Field>
        <Field label="Source">
          <Provenance kind={isUnverified(risk) ? "unverified" : "inferred"} detail={sourceLabel(risk.actionTarget)} />
          {link && (
            <div className="mt-1.5">
              {link.external ? (
                <a
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[12px] text-tertiary-text underline-offset-2 hover:text-foreground hover:underline"
                >
                  <ExternalLink className="size-3.5" /> {link.label}
                </a>
              ) : (
                <Link
                  href={link.href}
                  className="inline-flex items-center gap-1 text-[12px] text-tertiary-text underline-offset-2 hover:text-foreground hover:underline"
                >
                  {link.label}
                </Link>
              )}
            </div>
          )}
        </Field>
      </div>
      <div className="space-y-3">
        <Field label="Affected records">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
            <Row k="Scope" v={scopeKindLabel(scope)} />
            {risk.date && <Row k="Date" v={`${formatYmdLong(risk.date)} (${daysUntilLabel(risk.date, today)})`} />}
            {scope.tier === "event" && <Row k="Event" v={scope.eventId} mono />}
            {risk.routeId && <Row k="Route" v={risk.routeId} mono />}
            {risk.truckId && <Row k="Truck" v={risk.truckId} />}
            {risk.affectedEntity && <Row k="Who" v={risk.affectedEntity} />}
            {risk.deadline && <Row k="Deadline" v={new Date(risk.deadline).toLocaleString()} />}
            <Row k="Owner" v={risk.owner || "Unassigned"} />
            <Row k="Type" v={risk.riskType} mono />
          </dl>
        </Field>
        <Field label="History">
          {history.length === 0 ? (
            <p className="text-[11.5px] text-meta">
              First seen {relTime(risk.firstDetectedAt)}. No further lifecycle changes recorded.
            </p>
          ) : (
            <ul className="space-y-1 text-[11.5px]">
              {history.slice(0, 8).map((h) => (
                <li key={h.id} className="flex items-baseline gap-2">
                  <span className="shrink-0 tabular-nums text-meta">{new Date(h.ts).toLocaleDateString()}</span>
                  <span className="text-secondary-text">
                    {humanizeKind(h.kind)}
                    {h.fromValue && h.toValue ? ` (${h.fromValue} → ${h.toValue})` : h.toValue ? ` (${h.toValue})` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Field>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <div className="mb-1 text-[10.5px] font-medium uppercase tracking-[0.08em] text-meta">{label}</div>
      {children}
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }): React.JSX.Element {
  return (
    <>
      <dt className="text-meta">{k}</dt>
      <dd className={`text-secondary-text ${mono ? "font-mono text-[11px]" : ""}`}>{v}</dd>
    </>
  );
}

const KIND_LABEL: Record<string, string> = {
  risk_detected: "Detected",
  risk_escalated: "Escalated",
  risk_resolved: "Resolved",
  risk_regressed: "Regressed",
  risk_status_changed: "Status changed",
};
function humanizeKind(kind: string): string {
  return KIND_LABEL[kind] ?? kind.replace(/_/g, " ");
}
