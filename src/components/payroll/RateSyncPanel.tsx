"use client";

// Gusto → Connecteam rate sync (propose-first). Gusto is the authoritative pay-rate source, so these are the
// workers whose Connecteam hourly rate differs from Gusto (or is missing). Approving ONE row writes that Gusto
// rate into Connecteam (PUT), which funds payroll — so it is always an explicit, per-row human action here.
// Nothing writes automatically. The write is audited server-side and only reports success on a real 2xx.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRightLeft, Check } from "lucide-react";
import type { RateComparison } from "@/lib/payroll/types";

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

export function RateSyncPanel({ proposals, asOf, comparison }: {
  proposals: RateProposalView[]; asOf: string | null; comparison: RateComparison;
}): React.JSX.Element | null {
  const { verifiedMatch, differing, missingSourceRate, incomparableSalaried, mapped } = comparison;
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

  if (mapped === 0 && proposals.length === 0) return null;

  // Three DISTINCT populations — never conflated. "Comparable" = mapped workers with a Gusto HOURLY rate to
  // check against Connecteam; of those, verifiedMatch already agree and `differing` need a write. The other
  // two (no Gusto rate / salaried) CANNOT be compared at all, so they are reported separately — not folded
  // into "everyone matches".
  const comparable = verifiedMatch + differing;
  const breakdown: { label: string; n: number; tone: string }[] = [
    { label: "verified in sync", n: verifiedMatch, tone: "text-positive" },
    { label: "differ (writable)", n: differing, tone: "text-attention" },
    { label: "no Gusto rate — can't compare", n: missingSourceRate, tone: "text-meta" },
    { label: "salaried — n/a", n: incomparableSalaried, tone: "text-meta" },
  ].filter((b) => b.n > 0);

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <ArrowRightLeft className="size-3.5 text-tertiary-text" />
        <h3 className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-tertiary-text">
          Gusto → Connecteam rate sync
        </h3>
        <span className="text-[11px] text-meta">
          — Gusto is the authoritative pay rate. Approve a row to write it into Connecteam.
          {asOf && <span className="ml-1">Gusto pulled {new Date(asOf).toLocaleString("en-US")}.</span>}
        </span>
      </div>
      {/* Honest breakdown of all mapped workers across the three populations (fixes the old "11 have no rate"
          + "everyone matches" contradiction). */}
      <p className="mb-1.5 pl-5 text-[11.5px] text-meta">
        {comparable} of {mapped} mapped worker{mapped === 1 ? "" : "s"} comparable:{" "}
        {breakdown.map((b, i) => (
          <span key={b.label}>
            {i > 0 && <span className="text-meta"> · </span>}
            <span className={b.tone}>{b.n} {b.label}</span>
          </span>
        ))}
        {breakdown.length === 0 && <span>none to compare.</span>}
      </p>
      {proposals.length === 0 ? (
        <p className="pl-5 text-[12px] text-meta">
          {missingSourceRate > 0 || incomparableSalaried > 0
            ? `${verifiedMatch} comparable worker${verifiedMatch === 1 ? "" : "s"} already match Gusto; ${missingSourceRate + incomparableSalaried} could not be compared (see above).`
            : "Every comparable worker's Connecteam rate already matches Gusto."}
        </p>
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
