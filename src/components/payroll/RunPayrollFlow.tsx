"use client";

// Run payroll — ONE button for the week payroll runs for, replacing the old Approve / Push hours / Run payroll
// trio. Everything happens in one in-app dialog:
//
//   1. Approve: records the Zoe sign-off + locks the days in Connecteam (skipped if already approved; an
//      explicit acknowledgement is asked only when the remaining workers' timesheets are unverified).
//   2. Push: writes the hours into the Gusto DRAFT through the Auto-Pull extension (hidden Gusto tab).
//   3. Draft: shows what Gusto now holds per worker + who is left out and why.
//   4. Confirm + submit (admins only): the real numbers, a checkbox, then SubmitDraftPayroll (WIRE ONLY).
//
// Steps 1-2 are reversible (un-approve; a draft is not payroll). Step 4 is irreversible, so it always needs
// the explicit confirm on the real numbers. The dialog polls /api/payroll/gusto/status for what the extension
// reports, so it never sits silent: a signed-out Gusto or a stalled tab comes back as a clear reason.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Loader2, PlayCircle } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { canMessageExtension, sendToExtension } from "@/lib/extensionId";

interface PushEntry { gustoMemberId: string; name: string; regularHours: number; overtimeHours: number; doubleOvertimeHours: number }
interface PushPayload {
  entries: PushEntry[];
  mappedCount: number;
  skipped: { name: string; reason: string }[];
  totals: { regular: number; overtime: number };
  period: { start: string; end: string; label: string };
  checkDate?: string;
  error?: string;
}
interface PushWorker { gustoMemberId: string; name: string | null; outcome: "pushed" | "skipped" | "failed"; regularHours?: number | null; overtimeHours?: number | null; reason?: string | null }
interface ProgressStep { stage: string; detail: string | null; at: string }
interface StatusResponse {
  progress?: { push: ProgressStep | null; submit: ProgressStep | null };
  push: { at: string; ok: boolean; aborted: string | null; pushed: number; skipped: number; failed: number; workers: PushWorker[] } | null;
  submit: { at: string; ok: boolean; aborted: string | null; submitted: boolean; alreadySubmitted: boolean; errors: { message: string }[] } | null;
}
interface SubmitContext {
  period: { start: string; end: string; label: string };
  checkDate: string;
  expectedTotal: number | null;
  headcount: number;
  canRun: boolean;
  reason: string;
  initiatedBy: string | null;
  error?: string;
}

type Phase =
  | { kind: "ack" }
  | { kind: "working"; label: string; since: number; steps?: { stage: string; text: string }[] }
  | { kind: "error"; title: string; detail: string; retry: "start" | "submit" | null }
  | { kind: "draft"; plan: PushPayload; result: NonNullable<StatusResponse["push"]>; ctx: SubmitContext | null; ctxError: string | null }
  | { kind: "done"; ctx: SubmitContext };

const POLL_MS = 2000;

// What each step the extension reports means, in plain words.
const STAGE_LABEL: Record<string, string> = {
  opened: "Gusto opened",
  opening_run: "Opening this week's payroll run",
  choosing_wire: "Late payroll: choosing pay by wire",
  wire_terms: "Accepting Gusto's wire terms",
  hours_page: "Reached the hours page",
  writing: "Writing hours",
  submitting: "Submitting payroll",
};
const WAIT_MS = 210_000; // the extension's watchdog is 180s and it reports when it fires

const ABORT_TEXT: Record<string, string> = {
  not_logged_in: "Gusto is signed out. A Gusto tab is now open in front of you: sign in there, then click Try again.",
  no_response: "The Gusto tab never started the job. Update the Auto-Pull extension (v1.20.2 or later), make sure Gusto opens in this Chrome, then try again.",
  claimed_no_result: "The Gusto tab started but never finished. Try again; if it repeats, tell Claude the Gusto page shown here.",
  could_not_reach_inputs: "Couldn't reach the hours page of this week's Gusto draft. Check in Gusto that a draft payroll is open for this week.",
  not_a_draft: "This week's Gusto run is no longer a draft (it may already be submitted). Check it in Gusto.",
  no_graphql_headers: "Gusto loaded but the page did not finish starting. Try again.",
  could_not_find_run: "Couldn't find this week's payroll run in Gusto.",
  no_entries: "There were no hours to send.",
};
// Codes may carry where it stopped: "could_not_reach_inputs@/some/gusto/path".
function abortText(raw: string): string {
  if (raw.startsWith("exception:")) return `Gusto step failed: ${raw.slice(10)}`;
  const [code, where] = raw.split("@");
  const base = ABORT_TEXT[code] ?? `Gusto step stopped (${code}).`;
  return where ? `${base} (Gusto page: ${where})` : base;
}

const usd = (n: number | null): string =>
  n == null || !Number.isFinite(n) ? "shown in Gusto" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const h = (n: number | null | undefined): string => `${Math.round((n ?? 0) * 100) / 100}h`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function relTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return null;
  const m = Math.round((Date.now() - d) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const hr = Math.round(m / 60);
  return hr < 48 ? `${hr}h ago` : `${Math.round(hr / 24)}d ago`;
}

export function RunPayrollFlow({
  period, readyCount, acknowledgeableCount, ackReason, approved, canRun, pushDisabled, submitDisabled, lastPush, lastSubmit,
}: {
  period: { start: string; end: string; label: string };
  readyCount: number;
  acknowledgeableCount: number;
  ackReason: string | null;
  approved: boolean;
  canRun: boolean; // admin: may submit (irreversible). Others can approve + fill the draft.
  pushDisabled: boolean;
  submitDisabled: boolean;
  lastPush: { at: string; ok: boolean; aborted: string | null; pushed: number } | null;
  lastSubmit: { at: string; ok: boolean; submitted: boolean; aborted: string | null } | null;
}): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "working", label: "", since: 0 });
  const [checked, setChecked] = useState(false);
  const runId = useRef(0); // bumps on close so a stale poll loop stops writing state
  const lastSubmitCtx = useRef<SubmitContext | null>(null); // for "Try again" after a signed-out submit

  const ackOnly = !approved && readyCount === 0 && acknowledgeableCount > 0;
  const nothing = !approved && readyCount === 0 && acknowledgeableCount === 0;

  // Reaches the store build or the "Load unpacked" build, whichever is installed.
  async function send(type: string, payload: unknown): Promise<{ ok: boolean; reason?: string }> {
    const sent = await sendToExtension({ type, payload });
    if (!sent.ok) return { ok: false, reason: "no_extension" };
    const r = (sent.response ?? {}) as { push?: { ok: boolean; reason?: string }; submit?: { ok: boolean; reason?: string } };
    const inner = r.push ?? r.submit ?? { ok: true };
    return { ok: inner.ok !== false, reason: inner.reason };
  }

  async function waitFor<K extends "push" | "submit">(key: K, since: number, id: number): Promise<StatusResponse[K] | "timeout" | "closed"> {
    while (Date.now() - since < WAIT_MS) {
      await sleep(POLL_MS);
      if (runId.current !== id) return "closed";
      const res = await fetch("/api/payroll/gusto/status?which=previous", { cache: "no-store" }).catch(() => null);
      const data = (await res?.json().catch(() => null)) as StatusResponse | null;
      const r = data?.[key];
      if (r && Date.parse(r.at) >= since - 2000) return r as StatusResponse[K];
      // Live step from the Gusto tab: append it to the checklist the dialog shows.
      const p = data?.progress?.[key];
      if (p && Date.parse(p.at) >= since - 2000) {
        const label = STAGE_LABEL[p.stage] ?? p.stage;
        setPhase((cur) => {
          if (cur.kind !== "working") return cur;
          const steps = cur.steps ?? [];
          const last = steps[steps.length - 1];
          const text = p.detail ? `${label} (${p.detail})` : label;
          if (last && last.stage === p.stage) {
            return last.text === text ? cur : { ...cur, steps: [...steps.slice(0, -1), { stage: p.stage, text }] };
          }
          return { ...cur, steps: [...steps, { stage: p.stage, text }] };
        });
      }
    }
    return "timeout";
  }

  function noExtension(): void {
    setPhase({
      kind: "error",
      title: "Auto-Pull extension not found",
      detail: "Run payroll from the Chrome that has the Auto-Pull extension and a signed-in Gusto.",
      retry: null,
    });
  }

  function begin(): void {
    setOpen(true);
    setChecked(false);
    if (ackOnly) { setPhase({ kind: "ack" }); return; }
    void start(false);
  }

  async function start(acknowledge: boolean): Promise<void> {
    const id = ++runId.current;
    if (!canMessageExtension()) { noExtension(); return; }

    // 1) Approve (records the sign-off + locks Connecteam days). Skipped when already approved.
    if (!approved) {
      setPhase({ kind: "working", label: "Approving and locking hours in Connecteam…", since: Date.now() });
      const res = await fetch("/api/payroll/approve", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ start: period.start, end: period.end, acknowledge }),
      }).catch(() => null);
      const data = (await res?.json().catch(() => null)) as { error?: string } | null;
      if (runId.current !== id) return;
      if (!res?.ok) { setPhase({ kind: "error", title: "Approval failed", detail: data?.error ?? "Network error.", retry: "start" }); return; }
    }

    // 2) Build the push plan and hand it to the extension.
    setPhase({ kind: "working", label: "Preparing the hours…", since: Date.now() });
    const pres = await fetch("/api/payroll/gusto/push-payload", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ which: "previous" }),
    }).catch(() => null);
    const plan = (await pres?.json().catch(() => null)) as PushPayload | null;
    if (runId.current !== id) return;
    if (!pres?.ok || !plan) { setPhase({ kind: "error", title: "Couldn't prepare the hours", detail: plan?.error ?? "Network error.", retry: "start" }); return; }
    if (plan.mappedCount === 0) {
      setPhase({ kind: "error", title: "Nothing to send to Gusto", detail: plan.skipped.length ? `Everyone is held out: ${plan.skipped.map((s) => `${s.name} (${s.reason})`).join(", ")}.` : "No hours this period.", retry: null });
      return;
    }

    const since = Date.now();
    setPhase({ kind: "working", label: `Writing ${plan.mappedCount} workers' hours into the Gusto draft…`, since });
    const sent = await send("zoe-gusto-push", { which: "previous", period: plan.period, checkDate: plan.checkDate ?? null, entries: plan.entries });
    if (runId.current !== id) return;
    if (!sent.ok) {
      if (sent.reason === "no_extension") noExtension();
      else setPhase({ kind: "error", title: "Couldn't open Gusto", detail: `The extension could not open a Gusto tab (${sent.reason ?? "error"}).`, retry: "start" });
      return;
    }

    const result = await waitFor("push", since, id);
    if (result === "closed") return;
    if (result === "timeout" || result == null) {
      setPhase({ kind: "error", title: "Gusto didn't answer", detail: "No result came back from the Gusto tab. Make sure the Auto-Pull extension is on (v1.20.2 or later) and try again.", retry: "start" });
      return;
    }
    if (result.aborted) { setPhase({ kind: "error", title: "Hours not sent to Gusto", detail: abortText(result.aborted), retry: "start" }); return; }

    // 3) Show the draft, and (admins) load the submit numbers.
    setPhase({ kind: "draft", plan, result, ctx: null, ctxError: null });
    router.refresh();
    if (!canRun) return;
    const cres = await fetch("/api/payroll/gusto/submit-payload", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ which: "previous" }),
    }).catch(() => null);
    const ctx = (await cres?.json().catch(() => null)) as SubmitContext | null;
    if (runId.current !== id) return;
    if (cres?.ok && ctx) lastSubmitCtx.current = ctx;
    setPhase({ kind: "draft", plan, result, ctx: cres?.ok && ctx ? ctx : null, ctxError: cres?.ok ? (ctx?.canRun ? null : ctx?.reason ?? null) : ctx?.error ?? "Couldn't load the payroll totals." });
  }

  async function submit(ctx: SubmitContext): Promise<void> {
    const id = ++runId.current;
    const since = Date.now();
    setPhase({ kind: "working", label: "Submitting payroll in Gusto…", since });
    const sent = await send("zoe-gusto-submit", {
      which: "previous", period: ctx.period, checkDate: ctx.checkDate, expectedTotal: ctx.expectedTotal, headcount: ctx.headcount, initiatedBy: ctx.initiatedBy,
    });
    if (runId.current !== id) return;
    if (!sent.ok) {
      if (sent.reason === "no_extension") noExtension();
      else setPhase({ kind: "error", title: "Couldn't open Gusto", detail: `The extension could not open a Gusto tab (${sent.reason ?? "error"}).`, retry: "submit" });
      return;
    }
    const r = await waitFor("submit", since, id);
    if (r === "closed") return;
    if (r === "timeout" || r == null) {
      setPhase({ kind: "error", title: "Gusto didn't answer", detail: "No result came back from the Gusto tab. Check the payroll in Gusto before trying again, so it is never submitted twice.", retry: null });
      return;
    }
    if (r.aborted) { setPhase({ kind: "error", title: "Payroll not submitted", detail: abortText(r.aborted), retry: r.aborted === "not_logged_in" ? "submit" : null }); return; }
    if (!r.submitted) {
      setPhase({ kind: "error", title: "Payroll not submitted", detail: r.errors?.[0]?.message ?? "Gusto did not accept the submit. Check it in Gusto.", retry: null });
      return;
    }
    setPhase({ kind: "done", ctx });
    router.refresh();
  }

  function close(): void {
    runId.current++;
    setOpen(false);
    router.refresh();
  }

  const last = relTime(lastSubmit?.at ?? lastPush?.at ?? null);
  const statusLine = submitDisabled && pushDisabled ? "Gusto writes are turned off"
    : lastSubmit?.aborted ? `Last try ${last}: ${lastSubmit.aborted === "not_logged_in" ? "Gusto was signed out" : "stopped"}`
      : lastPush?.aborted ? `Last try ${last}: ${lastPush.aborted === "not_logged_in" ? "Gusto was signed out" : "hours not sent"}`
        : lastPush?.ok && last ? `Hours sent to the Gusto draft ${last}`
          : "Approves, fills the Gusto draft, then asks you to confirm";

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={begin}
        disabled={nothing || pushDisabled}
        className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-positive px-4 text-[13px] font-medium text-[#0b1f16] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <PlayCircle className="size-4" /> Run payroll
      </button>
      <span className="max-w-[18rem] text-right text-[11px] leading-snug text-meta">{statusLine}</span>

      <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Run payroll · {period.label}</DialogTitle>
            <DialogDescription render={<div />} className="text-[12.5px]">
              {phase.kind === "draft" ? "Hours are in the Gusto draft. Nothing is paid until you submit." : "Approve, fill the Gusto draft, review, then submit."}
            </DialogDescription>
          </DialogHeader>

          {phase.kind === "ack" && (
            <div className="space-y-2 text-[13px]">
              {ackReason && <p>{ackReason}</p>}
              <p>These timesheets are not approved in Connecteam. Continuing records that you accepted them and locks their days in Connecteam.</p>
            </div>
          )}

          {phase.kind === "working" && <WorkingView label={phase.label} since={phase.since} steps={phase.steps ?? []} />}

          {phase.kind === "error" && (
            <div className="flex gap-3 rounded-md border border-critical/40 bg-critical/10 p-3 text-[13px]">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-critical" />
              <div>
                <p className="font-medium text-foreground">{phase.title}</p>
                <p className="mt-1 text-secondary-text">{phase.detail}</p>
              </div>
            </div>
          )}

          {phase.kind === "draft" && <DraftView plan={phase.plan} result={phase.result} />}

          {phase.kind === "draft" && canRun && (
            <div className="space-y-2 border-t border-rule pt-3 text-[13px]">
              {phase.ctx ? (
                <>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                    <dt className="text-meta">Pay period</dt><dd>{phase.ctx.period.start} to {phase.ctx.period.end}</dd>
                    <dt className="text-meta">Check date</dt><dd>Set by Gusto (late runs paid by wire move to the next business day)</dd>
                    <dt className="text-meta">Employees in this run</dt><dd>{phase.ctx.headcount}</dd>
                    <dt className="text-meta">Estimated total</dt><dd>{usd(phase.ctx.expectedTotal)}</dd>
                  </dl>
                  <label className="flex items-start gap-2 text-[12.5px]">
                    <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
                    <span>I checked the hours and the total. Submitting runs payroll in Gusto, paid by wire only, and cannot be undone.</span>
                  </label>
                </>
              ) : phase.ctxError ? (
                <p className="text-attention">{phase.ctxError}</p>
              ) : (
                <p className="flex items-center gap-2 text-meta"><Loader2 className="size-3.5 animate-spin" /> Loading the payroll totals…</p>
              )}
            </div>
          )}
          {phase.kind === "draft" && !canRun && (
            <p className="border-t border-rule pt-3 text-[12.5px] text-meta">An administrator submits payroll from this page.</p>
          )}

          {phase.kind === "done" && (
            <div className="flex gap-3 rounded-md border border-positive/40 bg-positive/10 p-3 text-[13px]">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-positive" />
              <div>
                <p className="font-medium text-foreground">Payroll submitted in Gusto</p>
                <p className="mt-1 text-secondary-text">Wire {usd(phase.ctx.expectedTotal)} (or the amount Gusto shows) from Mercury, then click Confirm wire in Gusto on this page.</p>
              </div>
            </div>
          )}

          <DialogFooter>
            {phase.kind === "ack" && (
              <>
                <Button variant="outline" onClick={close}>Cancel</Button>
                <Button onClick={() => void start(true)}>Accept and continue</Button>
              </>
            )}
            {phase.kind === "working" && <Button variant="outline" onClick={close}>Close</Button>}
            {phase.kind === "error" && (
              <>
                <Button variant="outline" onClick={close}>Close</Button>
                {phase.retry === "start" && <Button onClick={() => void start(ackOnly)}>Try again</Button>}
                {phase.retry === "submit" && lastSubmitCtx.current && <Button onClick={() => void submit(lastSubmitCtx.current!)}>Try again</Button>}
              </>
            )}
            {phase.kind === "draft" && (
              <>
                <Button variant="outline" onClick={close}>{canRun ? "Not now" : "Close"}</Button>
                {canRun && (
                  <Button
                    variant="destructive"
                    disabled={!phase.ctx || !phase.ctx.canRun || !checked || submitDisabled || phase.result.failed > 0}
                    onClick={() => phase.ctx && void submit(phase.ctx)}
                  >
                    Submit payroll
                  </Button>
                )}
              </>
            )}
            {phase.kind === "done" && <Button onClick={close}>Done</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DraftView({ plan, result }: { plan: PushPayload; result: NonNullable<StatusResponse["push"]> }): React.JSX.Element {
  // What Gusto holds now: everything pushed or already set at the planned hours. Failures and workers missing
  // from the Gusto draft are called out; nobody is silently dropped.
  const byId = new Map(result.workers.map((w) => [w.gustoMemberId, w]));
  const rows = plan.entries.map((e) => {
    const w = byId.get(e.gustoMemberId);
    const note = !w ? "no result"
      : w.outcome === "failed" ? `failed: ${w.reason ?? "error"}`
        : w.outcome === "skipped" && w.reason && !/already set/i.test(w.reason) ? w.reason
          : null;
    return { e, ok: !!w && w.outcome !== "failed" && note == null, note };
  });
  const inGusto = rows.filter((r) => r.ok);
  const total = inGusto.reduce((s, r) => s + r.e.regularHours + r.e.overtimeHours, 0);

  return (
    <div className="space-y-3 text-[12.5px]">
      <div className="max-h-64 overflow-auto rounded-md border border-border">
        <table className="w-full">
          <thead className="sticky top-0 bg-popover text-[10.5px] uppercase tracking-[0.08em] text-meta">
            <tr><th className="px-3 py-1.5 text-left font-medium">Worker</th><th className="px-3 py-1.5 text-right font-medium">Hours</th></tr>
          </thead>
          <tbody>
            {rows.map(({ e, ok, note }) => (
              <tr key={e.gustoMemberId} className="border-t border-rule">
                <td className="px-3 py-1.5">
                  {e.name}
                  {!ok && note && <span className="ml-2 text-[11px] text-critical">{note}</span>}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {h(e.regularHours + e.overtimeHours)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border font-medium">
              <td className="px-3 py-1.5">{inGusto.length} in the Gusto draft</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{h(total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {plan.skipped.length > 0 && (
        <div>
          <p className="text-[10.5px] uppercase tracking-[0.08em] text-meta">Not included</p>
          <ul className="mt-1 space-y-0.5">
            {plan.skipped.map((s) => (
              <li key={s.name}><span className="text-foreground">{s.name}</span> <span className="text-meta">· {s.reason}</span></li>
            ))}
          </ul>
        </div>
      )}
      {result.failed > 0 && <p className="text-critical">Some hours did not save in Gusto. Try again before submitting.</p>}
    </div>
  );
}

// The live checklist while a step runs: finished steps get a check, the current one spins, and a seconds
// counter keeps ticking so it's obvious the run is alive even between Gusto updates.
function WorkingView({ label, since, steps }: { label: string; since: number; steps: { stage: string; text: string }[] }): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = since ? Math.max(0, Math.round((now - since) / 1000)) : 0;
  return (
    <div className="space-y-2 py-2 text-[13px]">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-foreground">{label}</span>
        {since > 0 && <span className="tabular-nums text-[11.5px] text-meta">{secs}s</span>}
      </div>
      {steps.length === 0 ? (
        <p className="flex items-center gap-2 text-secondary-text"><Loader2 className="size-3.5 animate-spin text-meta" /> Working…</p>
      ) : (
        <ol className="space-y-1">
          {steps.map((s, i) => {
            const current = i === steps.length - 1;
            return (
              <li key={`${s.stage}-${i}`} className={`flex items-center gap-2 ${current ? "text-foreground" : "text-meta"}`}>
                {current ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5 text-positive" />}
                {s.text}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
