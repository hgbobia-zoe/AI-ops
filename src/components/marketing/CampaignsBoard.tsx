"use client";

// Marketing campaigns — plan and track demand-gen campaigns across the team's channels, two-track by
// audience (weddings/social + corporate/gov). Manual, deterministic; the team enters budget/spend and
// real results. Add, edit inline, delete. No fabrication.

import { useEffect, useMemo, useState } from "react";
import { Plus, Pencil, Trash2, Loader2, Check, X, Megaphone } from "lucide-react";
import {
  CHANNELS, CHANNEL_LABEL, AUDIENCES, AUDIENCE_LABEL, CAMPAIGN_STATUS_ORDER, CAMPAIGN_STATUS_LABEL,
  type Campaign, type CampaignInput, type Channel, type Audience, type CampaignStatus,
} from "@/lib/marketing/types";

const INPUT = "w-full rounded border border-border bg-background px-2.5 py-1.5 text-[13px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const BTN = "inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50";

const STATUS_STYLE: Record<CampaignStatus, string> = {
  idea: "border-border text-meta",
  planned: "border-accent-foreground/30 text-tertiary-text",
  live: "border-positive/40 text-positive",
  paused: "border-attention/40 text-attention",
  done: "border-border text-meta",
};

function emptyDraft(): CampaignInput {
  return { name: "", objective: "", channels: [], audience: "both", status: "idea", budget: null, spend: null, startDate: null, endDate: null, goalMetric: "", resultLeads: null, resultBookings: null, resultRevenue: null, link: "", notes: "" };
}
function toDraft(c: Campaign): CampaignInput {
  return { name: c.name, objective: c.objective, channels: c.channels, audience: c.audience, status: c.status, budget: c.budget, spend: c.spend, startDate: c.startDate, endDate: c.endDate, goalMetric: c.goalMetric, resultLeads: c.resultLeads, resultBookings: c.resultBookings, resultRevenue: c.resultRevenue, link: c.link, notes: c.notes };
}
const numField = (v: number | null | undefined): string => (v == null ? "" : String(v));
const parseNum = (s: string): number | null => (s.trim() === "" ? null : Number(s));

function Editor({ draft, setDraft, onSave, onCancel, saving }: { draft: CampaignInput; setDraft: (d: CampaignInput) => void; onSave: () => void; onCancel: () => void; saving: boolean }): React.JSX.Element {
  const set = <K extends keyof CampaignInput>(k: K, v: CampaignInput[K]) => setDraft({ ...draft, [k]: v });
  const toggleChannel = (ch: Channel) => set("channels", (draft.channels ?? []).includes(ch) ? (draft.channels ?? []).filter((c) => c !== ch) : [...(draft.channels ?? []), ch]);
  return (
    <div className="space-y-3 rounded border border-border bg-[var(--row-hover)]/40 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 sm:col-span-2"><span className="text-[11px] text-meta">Campaign name</span><input className={INPUT} value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="Spring wedding season push" /></label>
        <label className="space-y-1 sm:col-span-2"><span className="text-[11px] text-meta">Objective</span><input className={INPUT} value={draft.objective} onChange={(e) => set("objective", e.target.value)} placeholder="Book 20 spring weddings" /></label>
        <label className="space-y-1"><span className="text-[11px] text-meta">Audience</span>
          <select className={INPUT} value={draft.audience} onChange={(e) => set("audience", e.target.value as Audience)}>{AUDIENCES.map((a) => <option key={a} value={a}>{AUDIENCE_LABEL[a]}</option>)}</select>
        </label>
        <label className="space-y-1"><span className="text-[11px] text-meta">Status</span>
          <select className={INPUT} value={draft.status} onChange={(e) => set("status", e.target.value as CampaignStatus)}>{CAMPAIGN_STATUS_ORDER.map((s) => <option key={s} value={s}>{CAMPAIGN_STATUS_LABEL[s]}</option>)}</select>
        </label>
      </div>
      <div className="space-y-1">
        <span className="text-[11px] text-meta">Channels</span>
        <div className="flex flex-wrap gap-2">
          {CHANNELS.map((ch) => {
            const on = (draft.channels ?? []).includes(ch);
            return <button key={ch} type="button" onClick={() => toggleChannel(ch)} className={`rounded border px-2.5 py-1 text-[12px] transition-colors ${on ? "border-foreground bg-foreground/10 font-medium text-foreground" : "border-border text-meta hover:bg-[var(--row-hover)]"}`}>{CHANNEL_LABEL[ch]}</button>;
          })}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="space-y-1"><span className="text-[11px] text-meta">Budget $</span><input className={INPUT} inputMode="numeric" value={numField(draft.budget)} onChange={(e) => set("budget", parseNum(e.target.value))} /></label>
        <label className="space-y-1"><span className="text-[11px] text-meta">Spend $</span><input className={INPUT} inputMode="numeric" value={numField(draft.spend)} onChange={(e) => set("spend", parseNum(e.target.value))} /></label>
        <label className="space-y-1"><span className="text-[11px] text-meta">Start</span><input type="date" className={INPUT} value={draft.startDate ?? ""} onChange={(e) => set("startDate", e.target.value || null)} /></label>
        <label className="space-y-1"><span className="text-[11px] text-meta">End</span><input type="date" className={INPUT} value={draft.endDate ?? ""} onChange={(e) => set("endDate", e.target.value || null)} /></label>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="space-y-1 sm:col-span-1"><span className="text-[11px] text-meta">Leads</span><input className={INPUT} inputMode="numeric" value={numField(draft.resultLeads)} onChange={(e) => set("resultLeads", parseNum(e.target.value))} /></label>
        <label className="space-y-1 sm:col-span-1"><span className="text-[11px] text-meta">Bookings</span><input className={INPUT} inputMode="numeric" value={numField(draft.resultBookings)} onChange={(e) => set("resultBookings", parseNum(e.target.value))} /></label>
        <label className="space-y-1 sm:col-span-2"><span className="text-[11px] text-meta">Revenue $</span><input className={INPUT} inputMode="numeric" value={numField(draft.resultRevenue)} onChange={(e) => set("resultRevenue", parseNum(e.target.value))} /></label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1"><span className="text-[11px] text-meta">Goal metric</span><input className={INPUT} value={draft.goalMetric} onChange={(e) => set("goalMetric", e.target.value)} placeholder="20 wedding leads" /></label>
        <label className="space-y-1"><span className="text-[11px] text-meta">Link</span><input className={INPUT} value={draft.link} onChange={(e) => set("link", e.target.value)} placeholder="https://…" /></label>
        <label className="space-y-1 sm:col-span-2"><span className="text-[11px] text-meta">Notes</span><textarea className={INPUT} rows={2} value={draft.notes} onChange={(e) => set("notes", e.target.value)} /></label>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={onSave} disabled={saving || !draft.name?.trim()} className={BTN + " border-foreground text-foreground"}>{saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Save</button>
        <button onClick={onCancel} className={BTN}><X className="size-3.5" /> Cancel</button>
      </div>
    </div>
  );
}

export function CampaignsBoard(): React.JSX.Element {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [audienceFilter, setAudienceFilter] = useState<"all" | Audience>("all");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<CampaignInput>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<CampaignInput>(emptyDraft);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/marketing/campaigns").then((r) => r.json()).then((j: { campaigns?: Campaign[] }) => setCampaigns(j.campaigns ?? [])).catch(() => setCampaigns([]));
  }, []);

  const shown = useMemo(() => (campaigns ?? []).filter((c) => audienceFilter === "all" || c.audience === audienceFilter || c.audience === "both"), [campaigns, audienceFilter]);

  async function reload() {
    const j = (await (await fetch("/api/marketing/campaigns")).json()) as { campaigns?: Campaign[] };
    setCampaigns(j.campaigns ?? []);
  }
  async function create() {
    setSaving(true);
    try {
      const r = await fetch("/api/marketing/campaigns", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
      if (r.ok) { setAdding(false); setDraft(emptyDraft()); await reload(); }
    } finally { setSaving(false); }
  }
  async function saveEdit(id: string) {
    setSaving(true);
    try {
      const r = await fetch(`/api/marketing/campaigns/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(editDraft) });
      if (r.ok) { setEditingId(null); await reload(); }
    } finally { setSaving(false); }
  }
  async function remove(id: string) {
    if (!window.confirm("Delete this campaign?")) return;
    await fetch(`/api/marketing/campaigns/${id}`, { method: "DELETE" });
    await reload();
  }

  const money = (n: number | null) => (n == null ? null : n >= 1000 ? `$${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : `$${Math.round(n)}`);

  return (
    <main className="max-w-[1000px] p-6">
      <div className="mb-4 text-[12px] text-meta"><span className="text-meta">Marketing</span> / Campaigns</div>
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight"><Megaphone className="size-5 text-meta" /> Campaigns</h1>
        <div className="flex items-center gap-2">
          <select value={audienceFilter} onChange={(e) => setAudienceFilter(e.target.value as "all" | Audience)} className="rounded border border-border bg-background px-2 py-1 text-[12.5px] text-tertiary-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            <option value="all">All audiences</option>
            {AUDIENCES.filter((a) => a !== "both").map((a) => <option key={a} value={a}>{AUDIENCE_LABEL[a]}</option>)}
          </select>
          {!adding && <button onClick={() => { setDraft(emptyDraft()); setAdding(true); }} className={BTN + " border-foreground text-foreground"}><Plus className="size-3.5" /> New campaign</button>}
        </div>
      </header>

      {adding && <div className="mb-4"><Editor draft={draft} setDraft={setDraft} onSave={create} onCancel={() => setAdding(false)} saving={saving} /></div>}

      {campaigns === null ? (
        <div className="flex items-center gap-2 text-[13px] text-meta"><Loader2 className="size-4 animate-spin" /> Loading…</div>
      ) : shown.length === 0 ? (
        <p className="text-[13px] text-meta">No campaigns yet. Plan one to start driving bookings.</p>
      ) : (
        <div className="space-y-2">
          {shown.map((c) => (
            editingId === c.id ? (
              <Editor key={c.id} draft={editDraft} setDraft={setEditDraft} onSave={() => saveEdit(c.id)} onCancel={() => setEditingId(null)} saving={saving} />
            ) : (
              <div key={c.id} className="rounded border border-border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{c.name}</span>
                      <span className={`rounded border px-1.5 py-px text-[10.5px] uppercase tracking-[0.05em] ${STATUS_STYLE[c.status]}`}>{CAMPAIGN_STATUS_LABEL[c.status]}</span>
                      <span className="text-[11px] text-meta">{AUDIENCE_LABEL[c.audience]}</span>
                    </div>
                    {c.objective && <p className="mt-0.5 text-[12.5px] text-tertiary-text">{c.objective}</p>}
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-meta">
                      {c.channels.length > 0 && <span>{c.channels.map((ch) => CHANNEL_LABEL[ch]).join(", ")}</span>}
                      {(c.startDate || c.endDate) && <span>{c.startDate ?? "?"} → {c.endDate ?? "?"}</span>}
                      {c.budget != null && <span className="tabular-nums">{money(c.spend)}/{money(c.budget)} spend</span>}
                      {(c.resultBookings != null || c.resultRevenue != null) && <span className="tabular-nums text-positive">{c.resultBookings != null ? `${c.resultBookings} bookings` : ""}{c.resultRevenue != null ? ` · ${money(c.resultRevenue)}` : ""}</span>}
                    </div>
                    {c.link && <a href={c.link} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-[12px] text-tertiary-text hover:text-foreground">Open ↗</a>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button onClick={() => { setEditDraft(toDraft(c)); setEditingId(c.id); }} className={BTN}><Pencil className="size-3.5" /></button>
                    <button onClick={() => remove(c.id)} className={BTN}><Trash2 className="size-3.5" /></button>
                  </div>
                </div>
              </div>
            )
          ))}
        </div>
      )}
    </main>
  );
}
