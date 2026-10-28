"use client";

// Gusto → Connecteam rate sync (propose-first). Gusto is the authoritative pay-rate source, so these are the
// workers whose Connecteam hourly rate differs from Gusto (or is missing). Approving ONE row writes that Gusto
// rate into Connecteam (PUT), which funds payroll — so it is always an explicit, per-row human action here.
// Nothing writes automatically. The write is audited server-side and only reports success on a real 2xx.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRightLeft, Check } from "lucide-react";

export interface RateProposalView {
  workerKey: string;
  name: string;
  connecteamUserId: number;
  gustoRate: number;
  connecteamRate: number | null;
  currency: string | null;
  effectiveDate: string;
  kind: "new" | "update";
}

const money = (n: number | null, cur = "USD"): string =>
  n == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: cur || "USD" }).format(n);

export function RateSyncPanel({ proposals, asOf, salaried, noGustoRate }: {
  proposals: RateProposalView[]; asOf: string | null; salaried: number; noGustoRate: number;
}): React.JSX.Element | null {
  const router = useRouter();
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<Record<string, string>>({});

  async function approve(p: RateProposalView): Promise<void> {
    setBusy(p.workerKey);
    setErr((e) => ({ ...e, [p.workerKey]: "" }));
    try {
      const res = await fetch("/api/payroll/rate-sync", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ connecteamUserId: p.connecteamUserId, gustoRate: p.gustoRate, effectiveDate: p.effectiveDate, name: p.name }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) setErr((e) => ({ ...e, [p.workerKey]: data?.error ?? "Write failed." }));
      else { setDone((d) => ({ ...d, [p.workerKey]: true })); router.refresh(); }
    } catch {
      setErr((e) => ({ ...e, [p.workerKey]: "Network error." }));
    } finally {
      setBusy(null);
    }
  }

  if (proposals.length === 0 && salaried === 0 && noGustoRate === 0) return null;

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <ArrowRightLeft className="size-3.5 text-tertiary-text" />
        <h3 className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-tertiary-text">
          Gusto → Connecteam rate sync <span className="text-meta">({proposals.length})</span>
        </h3>
        <span className="text-[11px] text-meta">
          — Gusto is the source of truth for pay. Approve to write a rate into Connecteam.
          {asOf && <span className="ml-1">Gusto pulled {new Date(asOf).toLocaleString("en-US")}.</span>}
        </span>
      </div>
      {(salaried > 0 || noGustoRate > 0) && (
        <p className="mb-1 pl-5 text-[11px] text-meta">
          {salaried > 0 && <span>{salaried} mapped worker{salaried === 1 ? "" : "s"} are salaried in Gusto (no hourly rate to sync). </span>}
          {noGustoRate > 0 && <span>{noGustoRate} mapped worker{noGustoRate === 1 ? "" : "s"} have no rate in the latest Gusto pull.</span>}
        </p>
      )}
      {proposals.length === 0 ? (
        <p className="pl-5 text-[12px] text-meta">Every mapped worker&apos;s Connecteam rate already matches Gusto.</p>
      ) : (
        <div className="surface overflow-x-auto border">
          <table className="w-full min-w-[720px] text-[12.5px]">
            <thead>
              <tr className="border-b border-rule text-left text-[10.5px] uppercase tracking-[0.06em] text-meta">
                <th className="px-3 py-2 font-medium">Worker</th>
                <th className="px-3 py-2 text-right font-medium">Connecteam now</th>
                <th className="px-3 py-2 text-right font-medium">Gusto (authoritative)</th>
                <th className="px-3 py-2 font-medium">Effective</th>
                <th className="px-3 py-2 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {proposals.map((p) => (
                <tr key={p.workerKey} className="border-b border-rule/60 last:border-0">
                  <td className="px-3 py-2 font-medium text-foreground">{p.name}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-secondary-text">
                    {p.connecteamRate == null ? <span className="text-attention">none</span> : `${money(p.connecteamRate, p.currency ?? "USD")}/hr`}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-foreground">{money(p.gustoRate, p.currency ?? "USD")}/hr</td>
                  <td className="px-3 py-2 text-tertiary-text">{p.effectiveDate}</td>
                  <td className="px-3 py-2 text-right">
                    {done[p.workerKey] ? (
                      <span className="inline-flex items-center gap-1 text-[11.5px] text-positive"><Check className="size-3.5" /> Written</span>
                    ) : (
                      <div className="flex flex-col items-end gap-0.5">
                        <button
                          onClick={() => approve(p)}
                          disabled={busy === p.workerKey}
                          className="inline-flex h-7 items-center rounded border border-border px-2.5 text-[11.5px] text-secondary-text transition-colors hover:bg-[var(--row-hover)] disabled:opacity-40"
                        >
                          {busy === p.workerKey ? "Writing…" : p.kind === "new" ? "Set in Connecteam" : "Update Connecteam"}
                        </button>
                        {err[p.workerKey] && <span className="text-[10.5px] text-critical">{err[p.workerKey]}</span>}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
