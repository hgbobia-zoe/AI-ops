"use client";

// Contractor pay (US + international) — the in-app review → confirm → stage-in-Gusto flow. Owner/admin (the
// /payroll blade is canManagePayroll-gated). It shows every contractor's Connecteam hours for the closed pay
// week, flags anyone who needs a decision (no Gusto match → Exclude, no rate, under Gusto's $25 international
// minimum), and on Confirm hands the ready rows to the Auto-Pull extension, which stages them as a Gusto DRAFT
// and has Gusto review it. Gusto's computed debits come back here. Paying stays a human click on "Submit
// payments" in Gusto (we link to the exact review page) — nothing in Zoe pays a contractor.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ExternalLink, Loader2, RefreshCw, Send } from "lucide-react";
import { EXTENSION_ID } from "@/lib/extensionId";
import type { ContractorPlan, ContractorPlanRow } from "@/lib/payroll/gustoContractorPay";
import type { ContractorRunResult } from "@/lib/payroll/gustoContractorState";

interface Payload {
  period: { start: string; end: string; label: string };
  which: "current" | "previous";
  disabled: boolean;
  connecteamOk: boolean;
  plan: ContractorPlan;
  exclusions: { key: string; mode: string | null; reason: string | null }[];
  job: Record<string, unknown>;
  lastRun: ContractorRunResult | null;
}
interface ChromeRuntimeLike {
  runtime?: { sendMessage?: (id: string, msg: unknown, cb?: (r: unknown) => void) => void; lastError?: { message?: string } };
}

type LoadResult = { data: Payload } | { error: string };

// Module-level (no setState) so the mount effect only applies the result in a callback.
async function fetchPayload(): Promise<LoadResult> {
  try {
    const r = await fetch("/api/payroll/gusto/contractor-payload", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ which: "previous" }), cache: "no-store",
    });
    const j = (await r.json().catch(() => null)) as (Payload & { error?: string }) | null;
    if (!r.ok || !j) return { error: j?.error ?? "Couldn't load the contractor review." };
    return { data: j };
  } catch {
    return { error: "Couldn't reach the server." };
  }
}

const usd = (n: number | null | undefined): string =>
  n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const STATUS_LABEL: Record<ContractorPlanRow["status"], string> = {
  ready: "Ready",
  excluded: "Excluded",
  no_gusto_match: "No Gusto match",
  no_hours: "No hours",
  no_rate: "No rate",
  below_minimum: "Under $25 minimum",
};
const STATUS_TONE: Record<ContractorPlanRow["status"], string> = {
  ready: "text-[var(--good,#16a34a)]",
  excluded: "text-meta",
  no_gusto_match: "text-[var(--warn,#d97706)]",
  no_hours: "text-meta",
  no_rate: "text-[var(--warn,#d97706)]",
  below_minimum: "text-[var(--warn,#d97706)]",
};
const ACH_LABEL: Record<string, string> = { four_day_ach: "4-day ACH", two_day_ach: "2-day ACH", next_day_ach: "next-day ACH" };

export function ContractorPayPanel(): React.JSX.Element {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [staging, setStaging] = useState(false);

  const apply = useCallback((res: LoadResult): Payload | null => {
    if ("error" in res) setError(res.error);
    else {
      setError(null);
      setData(res.data);
    }
    setLoading(false);
    return "data" in res ? res.data : null;
  }, []);
  const load = useCallback(async (): Promise<Payload | null> => apply(await fetchPayload()), [apply]);

  const refresh = useCallback(() => {
    setLoading(true);
    setConfirmed(false);
    void fetchPayload().then(apply);
  }, [apply]);

  useEffect(() => {
    void fetchPayload().then(apply);
  }, [apply]);

  async function exclude(row: ContractorPlanRow, mode: "period" | "permanent"): Promise<void> {
    if (!data) return;
    const ct = /^ct:(\d+)$/.exec(row.key);
    setBusyKey(row.key);
    const reason = mode === "permanent" ? "Paid another way (not through Gusto contractors)" : "Not paid in this contractor run";
    const r = await fetch("/api/payroll/worker/exclude", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "exclude", mode, reason, name: row.name, workerKey: row.key,
        connecteamUserId: ct ? Number(ct[1]) : undefined,
        periodStart: data.period.start, periodEnd: data.period.end,
      }),
    }).catch(() => null);
    setBusyKey(null);
    if (!r || !r.ok) {
      toast.error(`Couldn't exclude ${row.name}.`);
      return;
    }
    toast.success(mode === "permanent" ? `${row.name} is excluded from contractor pay until you re-include them.` : `${row.name} is excluded from this run.`);
    refresh();
  }

  async function include(row: ContractorPlanRow): Promise<void> {
    if (!data) return;
    const ex = data.exclusions.find((e) => e.key === row.key);
    const ct = /^ct:(\d+)$/.exec(row.key);
    setBusyKey(row.key);
    const r = await fetch("/api/payroll/worker/exclude", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "include", mode: ex?.mode === "permanent" ? "permanent" : "period", name: row.name, workerKey: row.key,
        connecteamUserId: ct ? Number(ct[1]) : undefined, periodStart: data.period.start, periodEnd: data.period.end,
      }),
    }).catch(() => null);
    setBusyKey(null);
    if (!r || !r.ok) toast.error(`Couldn't re-include ${row.name}.`);
    else refresh();
  }

  function stage(): void {
    if (!data) return;
    const chromeApi = (window as unknown as { chrome?: ChromeRuntimeLike }).chrome;
    if (!chromeApi?.runtime?.sendMessage) {
      toast.error("Auto-Pull extension not found in this browser", { description: "Stage from the computer that has the extension and a signed-in Gusto." });
      return;
    }
    setStaging(true);
    toast.loading("Staging contractor hours in Gusto…", { id: "stage-contractors" });
    const payload = { job: data.job, entries: data.plan.entries };
    chromeApi.runtime.sendMessage(EXTENSION_ID, { type: "zoe-gusto-contractor", payload }, (resp) => {
      if (chromeApi.runtime?.lastError) {
        toast.error("Couldn't reach the Auto-Pull extension", { id: "stage-contractors", description: "Update it to v1.19.0 or later." });
        setStaging(false);
        return;
      }
      void resp;
      // Poll for the extension's report (it stages + has Gusto review, usually well under a minute).
      const startedAt = Date.now();
      const prevAt = data.lastRun?.at ?? null;
      const tick = async (): Promise<void> => {
        const d = await load();
        if (d && d.lastRun && d.lastRun.at !== prevAt) {
          setData(d);
          setStaging(false);
          setConfirmed(false);
          if (d.lastRun.stage === "staged") toast.success("Staged in Gusto. Review and submit in Gusto.", { id: "stage-contractors" });
          else toast.error("Gusto did not accept the draft. See the details below.", { id: "stage-contractors" });
          return;
        }
        if (Date.now() - startedAt > 120_000) {
          setStaging(false);
          toast.error("No report from the extension yet. Check that Gusto is signed in, then refresh.", { id: "stage-contractors" });
          return;
        }
        setTimeout(() => void tick(), 4000);
      };
      setTimeout(() => void tick(), 5000);
    });
  }

  if (loading && !data) {
    return (
      <section className="surface flex items-center gap-2 border p-4 text-[13px] text-meta">
        <Loader2 className="size-4 animate-spin" /> Loading contractor hours…
      </section>
    );
  }
  if (error && !data) return <section className="surface border p-4 text-[13px] text-[var(--bad,#dc2626)]">{error}</section>;
  if (!data) return <></>;

  const { plan, lastRun } = data;
  const ready = plan.rows.filter((r) => r.status === "ready");
  const canStage = !data.disabled && ready.length > 0 && confirmed && !staging;

  return (
    <section className="surface space-y-4 border p-4" aria-labelledby="contractor-pay-h">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="contractor-pay-h" className="text-[15px] font-semibold">Contractor pay</h2>
          <p className="text-[12.5px] text-meta">
            {data.period.label}. Connecteam hours for US and international contractors. Gusto applies each rate; amounts here are estimates.
          </p>
        </div>
        <button onClick={refresh} disabled={loading || staging} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-[12.5px] text-secondary-text hover:bg-[var(--row-hover)] disabled:opacity-60">
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </header>

      {!data.connecteamOk && <p className="text-[12.5px] text-[var(--warn,#d97706)]">Connecteam is not responding, so hours may be missing. Refresh before staging.</p>}

      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead className="text-left text-[11px] uppercase tracking-wide text-meta">
            <tr>
              <th className="py-1.5 pr-3 font-medium">Contractor</th>
              <th className="py-1.5 pr-3 text-right font-medium">Hours</th>
              <th className="py-1.5 pr-3 text-right font-medium">Rate</th>
              <th className="py-1.5 pr-3 text-right font-medium">Est. pay</th>
              <th className="py-1.5 pr-3 font-medium">Status</th>
              <th className="py-1.5 font-medium" />
            </tr>
          </thead>
          <tbody>
            {plan.rows.length === 0 && (
              <tr><td colSpan={6} className="py-3 text-meta">No contractors on the roster for this period.</td></tr>
            )}
            {plan.rows.map((r) => (
              <tr key={r.key} className="border-t border-border align-top">
                <td className="py-2 pr-3">
                  {r.name}
                  <span className="ml-1.5 text-[11px] text-meta">{r.international ? "International" : "US"}</span>
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">{r.hours == null ? "—" : r.hours.toFixed(2)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{r.payRate == null ? "—" : `${usd(r.payRate)}/hr`}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{usd(r.estPay)}</td>
                <td className="py-2 pr-3">
                  <span className={`font-medium ${STATUS_TONE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                  {r.note && r.status !== "ready" && <div className="text-[11.5px] text-meta">{r.note}</div>}
                </td>
                <td className="whitespace-nowrap py-2 text-right">
                  {r.status === "excluded" ? (
                    <button disabled={busyKey === r.key} onClick={() => void include(r)} className="text-[12px] text-secondary-text underline-offset-2 hover:underline">Include</button>
                  ) : r.status !== "no_hours" ? (
                    <span className="inline-flex gap-3">
                      <button disabled={busyKey === r.key} onClick={() => void exclude(r, "period")} className="text-[12px] text-secondary-text underline-offset-2 hover:underline">Exclude this run</button>
                      {r.status === "no_gusto_match" && (
                        <button disabled={busyKey === r.key} onClick={() => void exclude(r, "permanent")} className="text-[12px] text-secondary-text underline-offset-2 hover:underline">Always exclude</button>
                      )}
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
          {ready.length > 0 && (
            <tfoot>
              <tr className="border-t border-border font-medium">
                <td className="py-2 pr-3">{ready.length} ready</td>
                <td className="py-2 pr-3 text-right tabular-nums">{plan.totalHours.toFixed(2)}</td>
                <td />
                <td className="py-2 pr-3 text-right tabular-nums">{usd(plan.estTotal)}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <label className="flex items-center gap-2 text-[12.5px]">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={!ready.length || data.disabled} />
          I reviewed these hours{plan.needsDecision ? ` (${plan.needsDecision} row${plan.needsDecision === 1 ? "" : "s"} still need a decision and will be left out)` : ""}.
        </label>
        <button
          onClick={stage}
          disabled={!canStage}
          title="Puts the ready contractors' hours on a Gusto draft and has Gusto review it. Does not pay."
          className="inline-flex h-8 items-center gap-2 rounded-md bg-foreground px-3 text-[12.5px] font-medium text-background disabled:opacity-50"
        >
          {staging ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
          {staging ? "Staging…" : `Stage ${ready.length} in Gusto`}
        </button>
      </div>
      {data.disabled && <p className="text-[12px] text-meta">Contractor staging is turned off (GUSTO_CONTRACTOR_DISABLED).</p>}

      {lastRun && <LastRun run={lastRun} />}
    </section>
  );
}

function LastRun({ run }: { run: ContractorRunResult }): React.JSX.Element {
  const when = new Date(run.at).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <div className="space-y-2 rounded-md border border-border p-3 text-[12.5px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          {run.stage === "staged" ? "Staged in Gusto, waiting for you to submit" : run.stage === "aborted" ? "Staging stopped" : "Gusto did not accept the draft"}
          <span className="ml-2 font-normal text-meta">{when}</span>
        </span>
        {run.reviewUrl && (
          <a href={run.reviewUrl} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 font-medium hover:bg-[var(--row-hover)]">
            Open in Gusto <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
      {run.aborted && (
        <p className="text-[var(--warn,#d97706)]">
          {run.aborted === "not_logged_in" ? "Gusto is signed out on the extension's computer. Sign in, then stage again." : `Reason: ${run.aborted}`}
        </p>
      )}
      {run.reviewErrors.length > 0 && (
        <ul className="list-disc pl-5 text-[var(--bad,#dc2626)]">{run.reviewErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>
      )}
      {run.members.length > 0 && (
        <table className="w-full">
          <tbody>
            {run.members.map((m, i) => (
              <tr key={m.memberUuid ?? m.key ?? i} className="border-t border-border">
                <td className="py-1 pr-3">{m.name}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{m.hours == null ? "—" : `${m.hours.toFixed(2)} h`}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{usd(m.debit)}</td>
                <td className="py-1 text-meta">{m.outcome === "staged" ? "On the draft" : m.outcome === "unmatched" ? "Not found in Gusto" : m.reason ?? "Failed"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {run.stage === "staged" && (
        <p className="text-meta">
          Gusto total {usd(run.totalDebit)}{run.achSpeed ? `, funded by ${ACH_LABEL[run.achSpeed] ?? run.achSpeed}` : ""}. In Gusto, check the worksheet, click Review summary, then Submit payments. Nothing is paid until you do.
        </p>
      )}
    </div>
  );
}
