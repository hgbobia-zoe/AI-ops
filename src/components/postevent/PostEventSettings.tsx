"use client";

// Post-Event configuration — the CONFIGURABLE review destination, the warm review-invite template, and
// the per-stage SLA thresholds. Stored in the settings KV, never hard-coded. Saving is owner/admin only
// (the API returns 403 otherwise, surfaced here). Copy follows the house rule: no dashes as punctuation,
// no emoji.

import { useEffect, useState } from "react";
import { Settings, Loader2, Check } from "lucide-react";
import { POSTEVENT_ACTIVE_STATES, POSTEVENT_STATE_LABEL, type PostEventConfig, type PostEventState } from "@/lib/postevent/types";

const INPUT = "w-full rounded border border-border bg-background px-2.5 py-1.5 text-[13px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function PostEventSettings(): React.JSX.Element {
  const [cfg, setCfg] = useState<PostEventConfig | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/postevent/settings")
      .then((r) => r.json())
      .then((j: { config: PostEventConfig }) => setCfg(j.config))
      .catch(() => setCfg(null));
  }, []);

  async function save(): Promise<void> {
    if (!cfg) return;
    setSaving(true);
    setErr(null);
    setSaved(false);
    try {
      const r = await fetch("/api/postevent/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cfg) });
      if (r.status === 403) {
        setErr("Only an owner or admin can change these settings.");
        return;
      }
      if (!r.ok) {
        setErr("Could not save.");
        return;
      }
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  if (!cfg) return <></>;

  return (
    <section className="mt-6 rounded border border-border">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2.5 text-[12px] font-medium uppercase tracking-[0.08em] text-tertiary-text">
        <Settings className="size-3.5 text-meta" /> Configuration
        <span className="ml-auto text-[11px] normal-case text-meta">{open ? "Hide" : "Review destination, template, SLA"}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-[var(--row-rule)] p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-[11px] text-meta">Review destination label</span>
              <input className={INPUT} value={cfg.reviewDestinationLabel} onChange={(e) => setCfg({ ...cfg, reviewDestinationLabel: e.target.value })} placeholder="Google" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-meta">Review link (URL)</span>
              <input className={INPUT} value={cfg.reviewDestinationUrl} onChange={(e) => setCfg({ ...cfg, reviewDestinationUrl: e.target.value })} placeholder="https://g.page/r/…/review" />
            </label>
          </div>
          <label className="block space-y-1">
            <span className="text-[11px] text-meta">Review invite template (warm, human, no dashes or emoji)</span>
            <textarea className={INPUT} rows={3} value={cfg.reviewTemplate} onChange={(e) => setCfg({ ...cfg, reviewTemplate: e.target.value })} />
          </label>
          <div>
            <div className="mb-1 text-[11px] uppercase tracking-[0.06em] text-meta">Stage SLA (days before a card is flagged stale)</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {POSTEVENT_ACTIVE_STATES.map((s: PostEventState) => (
                <label key={s} className="flex items-center justify-between gap-2 rounded border border-border px-2 py-1 text-[12px]">
                  <span className="min-w-0 truncate text-tertiary-text">{POSTEVENT_STATE_LABEL[s]}</span>
                  <input
                    type="number"
                    min={0}
                    className="w-14 rounded border border-border bg-background px-1.5 py-0.5 text-right text-[12px] tabular-nums"
                    value={cfg.slaDays[s] ?? 0}
                    onChange={(e) => setCfg({ ...cfg, slaDays: { ...cfg.slaDays, [s]: Math.max(0, Number(e.target.value) || 0) } })}
                  />
                </label>
              ))}
            </div>
          </div>
          {err && <p className="text-[12px] text-attention">{err}</p>}
          <div className="flex items-center gap-2">
            <button onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 rounded border border-foreground px-3 py-1.5 text-[12.5px] font-medium text-foreground disabled:opacity-50">
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Save
            </button>
            {saved && <span className="text-[12px] text-positive">Saved.</span>}
          </div>
        </div>
      )}
    </section>
  );
}
