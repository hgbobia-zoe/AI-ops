"use client";

// Payroll Review: the employee-first table (one row per worker, aligned numbers, a full-run totals row) with
// each worker's Connecteam day-by-day detail in a side panel. Presentation only: search, filters and sorting
// never change who is in the run, and every write still goes through the existing controls (approve, accept,
// edit, exclude) and the Run payroll flow.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ChevronDown, ChevronRight, Search, X } from "lucide-react";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusBadge } from "@/components/ui/status";
import type { Tone } from "@/lib/tone";
import type { UnifiedWorkerRow, UnifiedIssue } from "@/lib/payroll/types";
import { WORKER_TYPE_LABEL, MAPPING_STATUS_LABEL, RATE_SOURCE_LABEL } from "@/lib/payroll/types";
import { WorkerEditor, type GustoPick } from "@/components/payroll/WorkerEditor";
import { ExcludeControl } from "@/components/payroll/ExcludeControl";
import { ApproveControl } from "@/components/payroll/ApproveControl";
import { WorkerApproveControl } from "@/components/payroll/WorkerApproveControl";

export interface ReviewDay {
  date: string;
  hours: number;
  openPunch: boolean;
  approvalState: "approved" | "unapproved" | null;
  clockIn: string | null;
  clockOut: string | null;
}
export interface ReviewTimesheet {
  totalHours: number;
  approvalState: "APPROVED" | "UNAPPROVED" | "UNVERIFIED";
  openPunch: boolean;
  days: ReviewDay[];
}
export type ReviewRow = UnifiedWorkerRow & { excluded: boolean; approvable: boolean; timesheet: ReviewTimesheet | null };

type Filter = "in_run" | "attention" | "blockers" | "warnings" | "ready" | "excluded";
type Bucket = "blocked" | "warning" | "ready" | "excluded";

const bucketOf = (w: ReviewRow): Bucket =>
  w.excluded ? "excluded" : w.status === "BLOCKED" ? "blocked" : w.status === "READY" ? "ready" : "warning";
const BUCKET_RANK: Record<Bucket, number> = { blocked: 0, warning: 1, ready: 2, excluded: 3 };
const BUCKET_UI: Record<Bucket, { label: string; tone: Tone }> = {
  blocked: { label: "Blocked", tone: "critical" },
  warning: { label: "Needs review", tone: "attention" },
  ready: { label: "Ready", tone: "positive" },
  excluded: { label: "Excluded", tone: "neutral" },
};
const SEV_RANK: Record<UnifiedIssue["severity"], number> = { blocker: 0, review: 1, unverified: 2, setup: 3 };

// The plain-language version of the most important issue, for the table row. Setup notes (e.g. worker type
// not confirmed) never show in the row; they live in the details.
const ISSUE_TEXT: Record<string, string> = {
  NO_GUSTO_MAPPING: "Not linked to a Gusto person",
  DUPLICATE_GUSTO_MAPPING: "Linked to a Gusto person someone else uses",
  UNAPPROVED_TIMESHEET: "Timesheet not approved",
  APPROVAL_UNVERIFIED: "Timesheet approval can't be checked",
  MISSING_PUNCH: "Missing clock-out",
  NO_PAY_RATE: "No pay rate",
  SCHEDULE_DISCREPANCY: "Hours differ from the schedule",
};
function topIssue(w: ReviewRow): UnifiedIssue | null {
  const issues = w.issues.filter((i) => i.severity !== "setup").sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
  return issues[0] ?? null;
}
const issueText = (i: UnifiedIssue): string => ISSUE_TEXT[i.code] ?? i.label;

const money = (n: number | null | undefined, cur = "USD"): string =>
  n == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: cur || "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const hours = (n: number | null | undefined): string => (n == null ? "—" : n.toFixed(2));
const fmtDay = (ymd: string): string => {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
};
// A worker can be ticked for bulk approval only when the approval gate allows it and they are not approved yet.
const selectable = (w: ReviewRow): boolean => !w.excluded && w.approvable && w.approvalState !== "APPROVED_IN_ZOE";
const notSelectableReason = (w: ReviewRow): string =>
  w.excluded ? "Excluded from this run"
    : w.approvalState === "APPROVED_IN_ZOE" ? "Already approved"
      : w.status === "BLOCKED" ? "Blocked: fix the blocker first"
        : "Not approvable yet: open the worker for details";
const isContractor = (w: ReviewRow): boolean => w.workerType === "US_CONTRACTOR" || w.workerType === "INTERNATIONAL_CONTRACTOR";

export function PayrollReviewBoard({ rows, timesheetsOk, period, gustoMembers }: {
  rows: ReviewRow[];
  timesheetsOk: boolean;
  period: { start: string; end: string; label: string };
  gustoMembers: GustoPick[];
}): React.JSX.Element {
  const [filter, setFilter] = useState<Filter>("in_run");
  const [q, setQ] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  // Bulk actions: tick workers, then Actions > Approve selected. Only workers the approval gate allows can be
  // ticked (never blocked or already approved), and the server re-checks the same gate.
  const router = useRouter();
  const [ask, confirmDialog] = useConfirm();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);

  const inRun = useMemo(() => rows.filter((w) => !w.excluded), [rows]);
  const counts = useMemo(() => {
    const c = { in_run: inRun.length, attention: 0, blockers: 0, warnings: 0, ready: 0, excluded: rows.length - inRun.length };
    for (const w of inRun) {
      const b = bucketOf(w);
      if (b === "blocked") { c.blockers++; c.attention++; }
      else if (b === "warning") { c.warnings++; c.attention++; }
      else if (b === "ready") c.ready++;
    }
    return c;
  }, [rows, inRun]);
  // Totals are ALWAYS the full run, never the filtered view.
  const totals = useMemo(() => ({
    hours: inRun.reduce((s, w) => s + (w.hours ?? 0), 0),
    gross: inRun.reduce((s, w) => s + (w.estPay ?? 0), 0),
    grossPartial: inRun.some((w) => (w.hours ?? 0) > 0 && w.estPay == null),
  }), [inRun]);

  const visible = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return rows
      .filter((w) => {
        const b = bucketOf(w);
        if (filter === "in_run") return b !== "excluded";
        if (filter === "attention") return b === "blocked" || b === "warning";
        if (filter === "blockers") return b === "blocked";
        if (filter === "warnings") return b === "warning";
        if (filter === "ready") return b === "ready";
        return b === "excluded";
      })
      .filter((w) => !ql || w.name.toLowerCase().includes(ql))
      .sort((a, b) => BUCKET_RANK[bucketOf(a)] - BUCKET_RANK[bucketOf(b)] || a.name.localeCompare(b.name));
  }, [rows, filter, q]);

  const open = openKey ? rows.find((w) => w.key === openKey) ?? null : null;
  const selectableVisible = visible.filter(selectable);
  const selectedRows = rows.filter((w) => selected.has(w.key) && selectable(w));
  const allVisibleTicked = selectableVisible.length > 0 && selectableVisible.every((w) => selected.has(w.key));
  const toggle = (key: string): void => setSelected((cur) => { const n = new Set(cur); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const toggleAll = (): void => setSelected((cur) => {
    const n = new Set(cur);
    if (allVisibleTicked) for (const w of selectableVisible) n.delete(w.key);
    else for (const w of selectableVisible) n.add(w.key);
    return n;
  });

  async function approveSelected(): Promise<void> {
    setMenuOpen(false);
    const list = selectedRows;
    if (list.length === 0) return;
    const ok = await ask({
      title: `Approve ${list.length} timesheet${list.length === 1 ? "" : "s"}?`,
      body: (
        <>
          <p>This records the Zoe approval for each worker and locks their days in Connecteam for {period.label}. It does not submit payroll in Gusto.</p>
          <p className="text-meta">{list.map((w) => w.name).join(", ")}</p>
        </>
      ),
      confirmLabel: `Approve ${list.length}`,
    });
    if (!ok) return;
    setBusy(true);
    setBulkMsg(null);
    try {
      const res = await fetch("/api/payroll/approve", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ start: period.start, end: period.end, workerKeys: list.map((w) => w.key), acknowledge: true }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string; approvedKeys?: string[]; finalize?: { locked?: number; failed?: number; na?: number } } | null;
      if (!res.ok) {
        setBulkMsg({ text: data?.error ?? "Approval failed.", tone: "bad" });
      } else {
        const done = data?.approvedKeys?.length ?? 0;
        const skipped = list.length - done;
        const fin = data?.finalize;
        setBulkMsg({
          text: `Approved ${done} worker${done === 1 ? "" : "s"}.${fin?.locked ? " Locked in Connecteam." : ""}${fin?.failed ? ` ${fin.failed} Connecteam lock failed, approve again to retry.` : ""}${skipped > 0 ? ` ${skipped} not approvable right now.` : ""}`,
          tone: fin?.failed || skipped > 0 ? "bad" : "ok",
        });
        setSelected(new Set());
        router.refresh();
      }
    } catch {
      setBulkMsg({ text: "Approval failed. Network error.", tone: "bad" });
    } finally {
      setBusy(false);
    }
  }
  const chip = (f: Filter, label: string, n: number, sub = false): React.JSX.Element => (
    <button
      key={f}
      onClick={() => setFilter(f)}
      aria-pressed={filter === f}
      className={`rounded-md border px-2.5 py-1 text-[11.5px] transition-colors ${sub ? "ml-[-2px]" : ""} ${filter === f ? "border-foreground/30 bg-foreground/[0.08] text-foreground" : "border-border text-meta hover:text-foreground"}`}
    >
      {label} <span className="tabular-nums text-meta">{n}</span>
    </button>
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="relative">
          <button
            onClick={() => setMenuOpen((o) => !o)}
            disabled={selectedRows.length === 0 || busy}
            className="inline-flex h-[26px] items-center gap-1 rounded-md bg-foreground px-2.5 text-[11.5px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-35"
          >
            {busy ? "Working…" : "Actions"} <ChevronDown className="size-3.5" aria-hidden />
          </button>
          {menuOpen && selectedRows.length > 0 && (
            <div className="absolute left-0 top-8 z-20 w-56 overflow-hidden rounded-md border border-border bg-[var(--panel)] shadow-lg">
              <button onClick={() => void approveSelected()} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-secondary-text hover:bg-[var(--row-hover)] hover:text-foreground">
                <CheckCircle2 className="size-3.5 text-positive" aria-hidden /> Approve selected ({selectedRows.length})
              </button>
              <button onClick={() => { setSelected(new Set()); setMenuOpen(false); }} className="flex w-full items-center gap-2 border-t border-rule px-3 py-2 text-left text-[12px] text-meta hover:bg-[var(--row-hover)] hover:text-foreground">
                <X className="size-3.5" aria-hidden /> Clear selection
              </button>
            </div>
          )}
        </div>
        {selectedRows.length > 0 && (
          <span className="mr-1 inline-flex items-center gap-1 text-[11.5px] text-secondary-text">
            {selectedRows.length} selected
            <button onClick={() => setSelected(new Set())} aria-label="Clear selection" className="text-meta hover:text-foreground"><X className="size-3.5" /></button>
          </span>
        )}
        {chip("in_run", "In run", counts.in_run)}
        {chip("attention", "Needs attention", counts.attention)}
        {(filter === "attention" || filter === "blockers" || filter === "warnings") && (
          <span className="flex items-center gap-1 border-l border-rule pl-1.5">
            {chip("blockers", "Blockers", counts.blockers, true)}
            {chip("warnings", "Warnings", counts.warnings, true)}
          </span>
        )}
        {chip("ready", "Ready", counts.ready)}
        {chip("excluded", "Excluded", counts.excluded)}
        <label className="ml-auto flex items-center gap-1.5 rounded-md border border-border px-2 py-1">
          <Search className="size-3.5 text-meta" aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search workers" aria-label="Search workers" className="w-40 bg-transparent text-[12px] text-foreground outline-none placeholder:text-meta" />
        </label>
      </div>
      {bulkMsg && <p className={`text-[11.5px] ${bulkMsg.tone === "ok" ? "text-positive" : "text-attention"}`}>{bulkMsg.text}</p>}

      <div className="surface overflow-x-auto border">
        <table className="w-full min-w-[760px] text-[12.5px]">
          <thead>
            <tr className="border-b border-rule text-left text-[10.5px] uppercase tracking-[0.06em] text-meta">
              <th className="w-10 px-3 py-2.5">
                <input
                  type="checkbox"
                  aria-label="Select all workers that can be approved"
                  title={selectableVisible.length === 0 ? "No worker in this view can be approved" : "Select all that can be approved"}
                  disabled={selectableVisible.length === 0}
                  checked={allVisibleTicked}
                  onChange={toggleAll}
                  className="size-3.5 cursor-pointer disabled:cursor-not-allowed disabled:opacity-30"
                />
              </th>
              <th className="whitespace-nowrap px-3 py-2.5 font-medium">Worker</th>
              <th className="whitespace-nowrap px-3 py-2.5 text-right font-medium">Payable hours</th>
              <th className="whitespace-nowrap px-3 py-2.5 text-right font-medium">Pay rate</th>
              <th className="whitespace-nowrap px-3 py-2.5 text-right font-medium">Est. gross</th>
              <th className="whitespace-nowrap px-3 py-2.5 font-medium">Review status</th>
              <th className="whitespace-nowrap px-3 py-2.5 text-right font-medium"><span className="sr-only">Details</span></th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-meta">No workers in this view.</td></tr>
            )}
            {visible.map((w) => {
              const b = bucketOf(w);
              const ui = BUCKET_UI[b];
              const issue = b === "excluded" ? null : topIssue(w);
              return (
                <tr key={w.key} onClick={() => setOpenKey(w.key)} className={`cursor-pointer border-b border-rule/60 last:border-0 hover:bg-[var(--row-hover)] ${selected.has(w.key) && selectable(w) ? "bg-foreground/[0.04]" : ""}`}>
                  <td className="w-10 px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${w.name}`}
                      title={selectable(w) ? "Select to approve" : notSelectableReason(w)}
                      disabled={!selectable(w)}
                      checked={selected.has(w.key) && selectable(w)}
                      onChange={() => toggle(w.key)}
                      className="size-3.5 cursor-pointer disabled:cursor-not-allowed disabled:opacity-30"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-foreground">{w.name}</div>
                    {(isContractor(w) || w.workerType === "TEMPORARY_WORKER") && (
                      <div className="text-[10.5px] text-meta">{WORKER_TYPE_LABEL[w.workerType]}{isContractor(w) ? " · paid in Gusto contractor payments" : ""}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-secondary-text">{hours(w.hours)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-secondary-text">
                    {w.payRate == null ? <span className="text-attention">Missing</span> : <>{money(w.payRate, w.currency)}/hr</>}
                    {w.payRate != null && w.rateSource && <div className="text-[10px] text-meta">{RATE_SOURCE_LABEL[w.rateSource]}</div>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-secondary-text">{money(w.estPay, w.currency)}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge tone={ui.tone} size="sm">{ui.label}</StatusBadge>
                      {issue && <span className={`text-[11.5px] ${issue.severity === "blocker" ? "text-critical" : "text-attention"}`}>{issueText(issue)}</span>}
                      {b === "excluded" && <span className="text-[11.5px] text-meta">{w.excludeReason || (w.excludeMode === "period" ? "Excluded this period" : "Excluded permanently")}</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right text-meta"><ChevronRight className="ml-auto size-4" aria-hidden /></td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-border bg-[var(--row)]/40 text-[12px]">
              <td />
              <td className="px-3 py-2.5 font-medium text-foreground">
                Run total · {inRun.length} worker{inRun.length === 1 ? "" : "s"}
                {visible.length !== inRun.length && <span className="ml-2 font-normal text-meta">(showing {visible.length})</span>}
              </td>
              <td className="px-3 py-2.5 text-right font-medium tabular-nums text-foreground">{hours(totals.hours)}</td>
              <td />
              <td className="px-3 py-2.5 text-right font-medium tabular-nums text-foreground">
                {money(totals.gross)}{totals.grossPartial && <span className="block text-[10px] font-normal text-attention">some rates missing</span>}
              </td>
              <td colSpan={2} className="px-3 py-2.5 text-[11px] text-meta">Estimate from hours × rate. Gusto calculates the actual pay.</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <WorkerPanel worker={open} onClose={() => setOpenKey(null)} timesheetsOk={timesheetsOk} period={period} gustoMembers={gustoMembers} />
      {confirmDialog}
    </div>
  );
}

const CT_APPROVAL: Record<ReviewTimesheet["approvalState"], { label: string; tone: Tone }> = {
  APPROVED: { label: "Approved", tone: "positive" },
  UNAPPROVED: { label: "Not approved", tone: "attention" },
  UNVERIFIED: { label: "Not available", tone: "neutral" },
};
const LOCK_TEXT: Record<NonNullable<UnifiedWorkerRow["ctLockStatus"]>, { label: string; tone: Tone }> = {
  LOCKED: { label: "Days locked", tone: "positive" },
  FAILED: { label: "Lock failed, re-approve to retry", tone: "attention" },
  NA: { label: "Nothing to lock", tone: "neutral" },
  UNLOCKED: { label: "Unlocked", tone: "neutral" },
};

function Fact({ label, children, note }: { label: string; children: React.ReactNode; note?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-3 border-b border-rule/50 py-2 last:border-0">
      <dt className="text-[11.5px] text-meta">{label}</dt>
      <dd className="text-[12.5px] text-secondary-text">
        {children}
        {note && <div className="mt-0.5 text-[11px] text-meta">{note}</div>}
      </dd>
    </div>
  );
}

function WorkerPanel({ worker: w, onClose, timesheetsOk, period, gustoMembers }: {
  worker: ReviewRow | null; onClose: () => void; timesheetsOk: boolean; period: { start: string; end: string }; gustoMembers: GustoPick[];
}): React.JSX.Element {
  const b = w ? bucketOf(w) : "ready";
  const ts = w?.timesheet ?? null;
  const zoeApproved = w?.approvalState === "APPROVED_IN_ZOE";
  const ctNotApproved = ts?.approvalState === "UNAPPROVED";
  const issues = w ? [...w.issues].sort((a, c) => SEV_RANK[a.severity] - SEV_RANK[c.severity]) : [];

  return (
    <Dialog open={w != null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        className="top-0 right-0 left-auto h-dvh max-h-dvh content-start w-full max-w-[min(34rem,100vw)] translate-x-0 translate-y-0 overflow-y-auto rounded-none p-5 sm:max-w-[34rem] data-open:zoom-in-100 data-closed:zoom-out-100"
      >
        {w && (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2">
                <DialogTitle className="text-[16px]">{w.name}</DialogTitle>
                <StatusBadge tone={BUCKET_UI[b].tone} size="sm">{BUCKET_UI[b].label}</StatusBadge>
              </div>
              <DialogDescription className="text-[12px]">
                {WORKER_TYPE_LABEL[w.workerType]} · {hours(w.hours)} payable hours · est. {money(w.estPay, w.currency)}
              </DialogDescription>
            </DialogHeader>

            {/* Why this status: every issue in plain words, most important first. */}
            {issues.length > 0 && b !== "excluded" && (
              <section className="space-y-1.5">
                {issues.map((i) => (
                  <div key={i.code} className={`rounded-md border px-3 py-2 text-[12px] ${i.severity === "blocker" ? "border-critical/40 bg-critical/10" : i.severity === "setup" ? "border-border" : "border-attention/40 bg-attention/10"}`}>
                    <div className="font-medium text-foreground">{issueText(i)}{i.severity === "blocker" && <span className="ml-1.5 text-[11px] font-normal text-critical">blocks this worker</span>}</div>
                    {i.detail && <div className="mt-0.5 text-secondary-text">{i.detail}</div>}
                  </div>
                ))}
              </section>
            )}
            {b === "excluded" && (
              <p className="rounded-md border border-border px-3 py-2 text-[12px] text-secondary-text">
                Excluded {w.excludeMode === "period" ? "for this period" : "permanently"}{w.excludeReason ? `: ${w.excludeReason}` : "."} Not part of the run or its totals.
              </p>
            )}

            {/* The separate facts, never merged into one label. */}
            <dl>
              <Fact label="Zoe approval" note={zoeApproved ? "This is the payroll sign-off." : undefined}>
                {zoeApproved ? `Approved${w.zoeApprovedBy ? ` by ${w.zoeApprovedBy}` : ""}` : w.approvalState === "APPROVED" ? "Approved in Connecteam" : "Not approved yet"}
              </Fact>
              <Fact
                label="Connecteam approval"
                note={zoeApproved && ctNotApproved ? "Connecteam's own approval column isn't used for payroll here. The Zoe approval is what counts, which is why this worker can be Ready." : undefined}
              >
                {ts ? <StatusBadge tone={CT_APPROVAL[ts.approvalState].tone} size="sm">{CT_APPROVAL[ts.approvalState].label}</StatusBadge> : <span className="text-meta">{w.connecteamUserId == null ? "Not a Connecteam user" : timesheetsOk ? "No records" : "Connecteam unreachable"}</span>}
              </Fact>
              <Fact label="Connecteam lock" note={w.ctLockDetail ?? (zoeApproved ? undefined : "Locking happens when the worker is approved in Zoe. It stops edits in Connecteam.")}>
                {w.ctLockStatus ? <StatusBadge tone={LOCK_TEXT[w.ctLockStatus].tone} size="sm">{LOCK_TEXT[w.ctLockStatus].label}</StatusBadge> : <span className="text-meta">Not locked</span>}
              </Fact>
              <Fact label="Gusto">
                <span className={w.gustoMapped ? "" : "text-attention"}>{w.gustoMapped ? "Linked" : "Not linked"}</span>
                <span className="ml-1.5 text-[11px] text-meta">{MAPPING_STATUS_LABEL[w.mappingStatus]}</span>
                {isContractor(w) && <div className="mt-0.5 text-[11px] text-meta">Contractor: paid through Gusto contractor payments, not the employee run.</div>}
              </Fact>
              <Fact
                label="Pay rate"
                note={w.gustoRate != null && w.connecteamRate != null && Math.abs(w.gustoRate - w.connecteamRate) > 0.004
                  ? `Gusto ${money(w.gustoRate, w.currency)}/hr, Connecteam ${money(w.connecteamRate, w.currency)}/hr. Gusto is the pay rate of record.`
                  : undefined}
              >
                {w.payRate == null ? <span className="text-attention">Missing</span> : `${money(w.payRate, w.currency)}/hr`}
                {w.rateSource && <span className="ml-1.5 text-[11px] text-meta">from {RATE_SOURCE_LABEL[w.rateSource]}</span>}
              </Fact>
            </dl>

            {/* Connecteam day by day. Missing data is never shown as zero. */}
            <section>
              <h3 className="mb-1.5 text-[10.5px] uppercase tracking-[0.08em] text-meta">Daily timesheet · Connecteam</h3>
              {w.connecteamUserId == null ? (
                <p className="text-[12px] text-meta">Not a Connecteam user, so there is no daily timesheet.</p>
              ) : !timesheetsOk ? (
                <p className="text-[12px] text-attention">Connecteam is unreachable right now, so the days can&apos;t be shown. Hours are not assumed.</p>
              ) : !ts || ts.days.length === 0 ? (
                <p className="text-[12px] text-meta">No days recorded in Connecteam for this period.</p>
              ) : (
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-rule text-left text-[10px] uppercase tracking-[0.06em] text-meta">
                      <th className="py-1.5 pr-2 font-medium">Day</th>
                      <th className="py-1.5 pr-2 text-right font-medium">Hours</th>
                      <th className="py-1.5 pr-2 font-medium">In</th>
                      <th className="py-1.5 pr-2 font-medium">Out</th>
                      <th className="py-1.5 font-medium">Flag</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ts.days.map((d) => (
                      <tr key={d.date} className="border-b border-rule/40 last:border-0">
                        <td className="py-1.5 pr-2 text-secondary-text">{fmtDay(d.date)}</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums text-secondary-text">{hours(d.hours)}</td>
                        <td className="py-1.5 pr-2 tabular-nums text-tertiary-text">{d.clockIn ?? <span className="text-meta">not shown</span>}</td>
                        <td className="py-1.5 pr-2 tabular-nums text-tertiary-text">{d.openPunch ? <span className="text-attention">open</span> : d.clockOut ?? <span className="text-meta">not shown</span>}</td>
                        <td className="py-1.5 text-[11px]">
                          {d.openPunch ? <span className="text-attention">Missing clock-out</span>
                            : d.approvalState === "unapproved" ? <span className="text-attention">Not approved</span>
                              : d.approvalState === "approved" ? <span className="text-positive">Approved</span>
                                : <span className="text-meta">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-rule text-[12px]">
                      <td className="py-1.5 font-medium text-foreground">{ts.days.length} day{ts.days.length === 1 ? "" : "s"}</td>
                      <td className="py-1.5 pr-2 text-right font-medium tabular-nums text-foreground">{hours(ts.totalHours)}</td>
                      <td colSpan={3} />
                    </tr>
                  </tfoot>
                </table>
              )}
            </section>

            {/* Routine actions live here, not in the table. Right-aligned so the Exclude menu (which opens leftward) stays inside the panel. */}
            <section className="flex flex-wrap items-center justify-end gap-2 border-t border-rule pt-3">
              {w.excluded ? (
                <ExcludeControl workerKey={w.key} recordId={w.recordId} connecteamUserId={w.connecteamUserId} name={w.name} periodStart={period.start} periodEnd={period.end} excluded excludeMode={w.excludeMode} />
              ) : (
                <>
                  {w.approvable && !zoeApproved && <WorkerApproveControl workerKey={w.key} name={w.name} periodStart={period.start} periodEnd={period.end} />}
                  {w.status === "ACTION_REQUIRED" && <ApproveControl workerKey={w.key} name={w.name} periodStart={period.start} periodEnd={period.end} />}
                  {w.accepted && <ApproveControl workerKey={w.key} name={w.name} periodStart={period.start} periodEnd={period.end} accepted acceptedBy={w.acceptedBy} />}
                  <WorkerEditor
                    worker={{ recordId: w.recordId, connecteamUserId: w.connecteamUserId, name: w.name, workerType: w.workerType, payType: w.payType, payRate: w.payRate, currency: w.currency, country: w.country, gustoId: w.gustoId }}
                    gustoMembers={gustoMembers}
                  />
                  <ExcludeControl workerKey={w.key} recordId={w.recordId} connecteamUserId={w.connecteamUserId} name={w.name} periodStart={period.start} periodEnd={period.end} />
                </>
              )}
            </section>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
