"use client";

// HR / Payroll settings form — edits the policy the engine + scheduler read (schedule, approval policy,
// overtime threshold, pay period). Saves to /api/payroll/settings; the server is the source of truth.

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PayrollConfig } from "@/lib/payroll/config";

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const HOURS = Array.from({ length: 24 }, (_, h) => ({ v: h, label: `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? "AM" : "PM"}` }));

const fieldCls = "h-8 rounded border border-border bg-[var(--panel)] px-2 text-[12.5px] text-foreground";
const labelCls = "text-[10.5px] uppercase tracking-[0.08em] text-meta";

export function PayrollSettingsForm({ initial }: { initial: PayrollConfig }): React.JSX.Element {
  const router = useRouter();
  const [cfg, setCfg] = useState<PayrollConfig>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const set = <K extends keyof PayrollConfig>(k: K, v: PayrollConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));

  async function save(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/payroll/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cfg) });
      setMsg(res.ok ? "Saved." : "Save failed.");
      if (res.ok) router.refresh();
    } catch {
      setMsg("Save failed — network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="surface border p-4">
      <h3 className="mb-3 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-tertiary-text">Schedule &amp; policy</h3>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4">
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Pay period</span>
          <select className={fieldCls} value={cfg.payPeriod} onChange={(e) => set("payPeriod", e.target.value as PayrollConfig["payPeriod"])}>
            <option value="weekly">Weekly (Mon–Sun)</option>
            <option value="biweekly">Biweekly</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Overtime threshold (hrs/week)</span>
          <input type="number" min={1} max={168} className={fieldCls} value={cfg.overtimeThreshold} onChange={(e) => set("overtimeThreshold", Number(e.target.value))} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Automatic sync</span>
          <select className={fieldCls} value={cfg.autoSyncEnabled ? "on" : "off"} onChange={(e) => set("autoSyncEnabled", e.target.value === "on")}>
            <option value="off">Disabled</option>
            <option value="on">Enabled</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Approval policy</span>
          <select className={fieldCls} value={cfg.approvalPolicy} onChange={(e) => set("approvalPolicy", e.target.value as PayrollConfig["approvalPolicy"])}>
            <option value="always_require">Always require approval</option>
            <option value="auto_if_clean">Auto-approve when clean</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Sync day</span>
          <select className={fieldCls} value={cfg.syncDay} onChange={(e) => set("syncDay", Number(e.target.value))} disabled={!cfg.autoSyncEnabled}>
            {DOW.map((d, i) => <option key={i} value={i}>{d}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Sync time (ET)</span>
          <select className={fieldCls} value={cfg.syncHour} onChange={(e) => set("syncHour", Number(e.target.value))} disabled={!cfg.autoSyncEnabled}>
            {HOURS.map((h) => <option key={h.v} value={h.v}>{h.label}</option>)}
          </select>
        </label>
      </div>
      <div className="mt-4 flex items-center gap-3 border-t border-rule pt-4">
        <button onClick={save} disabled={busy} className="inline-flex h-9 items-center justify-center rounded-md bg-foreground px-4 text-[13px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-60">
          {busy ? "Saving…" : "Save settings"}
        </button>
        {msg && <span className={`text-[11.5px] ${msg === "Saved." ? "text-positive" : "text-critical"}`}>{msg}</span>}
        <span className="text-[11px] text-meta">Auto-sync never pushes to Gusto with blockers; it prepares the review and notifies.</span>
      </div>
    </section>
  );
}
