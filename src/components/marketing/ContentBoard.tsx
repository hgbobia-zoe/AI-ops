"use client";

// Marketing content calendar — the in-app plan for what's going out and when. The team plans in
// Confluence and posts through their social tool; this tracks the schedule and status so the Command
// Center can show what's queued and what's overdue. Manual, deterministic.

import { useEffect, useMemo, useState } from "react";
import { Plus, Pencil, Trash2, Loader2, Check, X, CalendarDays, ExternalLink } from "lucide-react";
import {
  CHANNELS, CHANNEL_LABEL, AUDIENCES, AUDIENCE_LABEL, CONTENT_STATUS_ORDER, CONTENT_STATUS_LABEL,
  type ContentItem, type ContentInput, type Channel, type Audience, type ContentStatus,
} from "@/lib/marketing/types";

const INPUT = "w-full rounded border border-border bg-background px-2.5 py-1.5 text-[13px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const BTN = "inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50";
const STATUS_STYLE: Record<ContentStatus, string> = { idea: "border-border text-meta", drafting: "border-attention/40 text-attention", scheduled: "border-accent-foreground/30 text-tertiary-text", posted: "border-positive/40 text-positive" };

function emptyDraft(): ContentInput { return { title: "", channel: null, format: "", planDate: null, status: "idea", audience: "both", owner: "", link: "", notes: "" }; }
function toDraft(c: ContentItem): ContentInput { return { title: c.title, channel: c.channel, format: c.format, planDate: c.planDate, status: c.status, audience: c.audience, owner: c.owner, link: c.link, notes: c.notes }; }

function Editor({ draft, setDraft, onSave, onCancel, saving }: { draft: ContentInput; setDraft: (d: ContentInput) => void; onSave: () => void; onCancel: () => void; saving: boolean }): React.JSX.Element {
  const set = <K extends keyof ContentInput>(k: K, v: ContentInput[K]) => setDraft({ ...draft, [k]: v });
  return (
    <div className="space-y-3 rounded border border-border bg-[var(--row-hover)]/40 p-3">
      <label className="block space-y-1"><span className="text-[11px] text-meta">Title</span><input className={INPUT} value={draft.title} onChange={(e) => set("title", e.target.value)} placeholder="Real wedding feature — Glenview Mansion" /></label>
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="space-y-1"><span className="text-[11px] text-meta">Channel</span>
          <select className={INPUT} value={draft.channel ?? ""} onChange={(e) => set("channel", (e.target.value || null) as Channel | null)}><option value="">—</option>{CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}</select>
        </label>
        <label className="space-y-1"><span className="text-[11px] text-meta">Format</span><input className={INPUT} value={draft.format} onChange={(e) => set("format", e.target.value)} placeholder="reel, blog…" /></label>
        <label className="space-y-1"><span className="text-[11px] text-meta">Status</span>
          <select className={INPUT} value={draft.status} onChange={(e) => set("status", e.target.value as ContentStatus)}>{CONTENT_STATUS_ORDER.map((s) => <option key={s} value={s}>{CONTENT_STATUS_LABEL[s]}</option>)}</select>
        </label>
        <label className="space-y-1"><span className="text-[11px] text-meta">Plan date</span><input type="date" className={INPUT} value={draft.planDate ?? ""} onChange={(e) => set("planDate", e.target.value || null)} /></label>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1"><span className="text-[11px] text-meta">Audience</span>
          <select className={INPUT} value={draft.audience} onChange={(e) => set("audience", e.target.value as Audience)}>{AUDIENCES.map((a) => <option key={a} value={a}>{AUDIENCE_LABEL[a]}</option>)}</select>
        </label>
        <label className="space-y-1"><span className="text-[11px] text-meta">Owner</span><input className={INPUT} value={draft.owner} onChange={(e) => set("owner", e.target.value)} /></label>
        <label className="space-y-1"><span className="text-[11px] text-meta">Link</span><input className={INPUT} value={draft.link} onChange={(e) => set("link", e.target.value)} placeholder="Confluence / post" /></label>
      </div>
      <label className="block space-y-1"><span className="text-[11px] text-meta">Notes</span><textarea className={INPUT} rows={2} value={draft.notes} onChange={(e) => set("notes", e.target.value)} /></label>
      <div className="flex items-center gap-2">
        <button onClick={onSave} disabled={saving || !draft.title?.trim()} className={BTN + " border-foreground text-foreground"}>{saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Save</button>
        <button onClick={onCancel} className={BTN}><X className="size-3.5" /> Cancel</button>
      </div>
    </div>
  );
}

export function ContentBoard({ confluenceUrl, posterUrl }: { confluenceUrl?: string; posterUrl?: string }): React.JSX.Element {
  const [items, setItems] = useState<ContentItem[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<ContentInput>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<ContentInput>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const today = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    fetch("/api/marketing/content").then((r) => r.json()).then((j: { content?: ContentItem[] }) => setItems(j.content ?? [])).catch(() => setItems([]));
  }, []);

  const sorted = useMemo(() => [...(items ?? [])].sort((a, b) => (a.planDate ?? "9999").localeCompare(b.planDate ?? "9999")), [items]);

  async function reload() { const j = (await (await fetch("/api/marketing/content")).json()) as { content?: ContentItem[] }; setItems(j.content ?? []); }
  async function create() { setSaving(true); try { const r = await fetch("/api/marketing/content", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) }); if (r.ok) { setAdding(false); setDraft(emptyDraft()); await reload(); } } finally { setSaving(false); } }
  async function saveEdit(id: string) { setSaving(true); try { const r = await fetch(`/api/marketing/content/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(editDraft) }); if (r.ok) { setEditingId(null); await reload(); } } finally { setSaving(false); } }
  async function remove(id: string) { if (!window.confirm("Delete this content item?")) return; await fetch(`/api/marketing/content/${id}`, { method: "DELETE" }); await reload(); }

  return (
    <main className="max-w-[1000px] p-6">
      <div className="mb-4 text-[12px] text-meta"><span className="text-meta">Marketing</span> / Content calendar</div>
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight"><CalendarDays className="size-5 text-meta" /> Content calendar</h1>
        <div className="flex flex-wrap items-center gap-2">
          {confluenceUrl && <a href={confluenceUrl} target="_blank" rel="noopener noreferrer" className={BTN}>Plan in Confluence <ExternalLink className="size-3" /></a>}
          {posterUrl && <a href={posterUrl} target="_blank" rel="noopener noreferrer" className={BTN}>Open poster <ExternalLink className="size-3" /></a>}
          {!adding && <button onClick={() => { setDraft(emptyDraft()); setAdding(true); }} className={BTN + " border-foreground text-foreground"}><Plus className="size-3.5" /> Add</button>}
        </div>
      </header>

      {adding && <div className="mb-4"><Editor draft={draft} setDraft={setDraft} onSave={create} onCancel={() => setAdding(false)} saving={saving} /></div>}

      {items === null ? (
        <div className="flex items-center gap-2 text-[13px] text-meta"><Loader2 className="size-4 animate-spin" /> Loading…</div>
      ) : sorted.length === 0 ? (
        <p className="text-[13px] text-meta">Nothing planned yet. Add the posts, emails, and blog pieces you have coming up.</p>
      ) : (
        <div className="overflow-hidden rounded border border-border">
          {sorted.map((c) => (
            editingId === c.id ? (
              <div key={c.id} className="border-t border-[var(--row-rule)] p-3 first:border-t-0"><Editor draft={editDraft} setDraft={setEditDraft} onSave={() => saveEdit(c.id)} onCancel={() => setEditingId(null)} saving={saving} /></div>
            ) : (
              <div key={c.id} className="flex items-center gap-3 border-t border-[var(--row-rule)] px-3 py-2.5 text-[13px] first:border-t-0">
                <span className={`w-24 shrink-0 tabular-nums text-[12px] ${c.planDate && c.planDate < today && c.status !== "posted" ? "text-attention" : "text-meta"}`}>{c.planDate ?? "no date"}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-foreground">{c.title}</span>
                    <span className={`rounded border px-1.5 py-px text-[10px] uppercase tracking-[0.05em] ${STATUS_STYLE[c.status]}`}>{CONTENT_STATUS_LABEL[c.status]}</span>
                  </div>
                  <div className="text-[11.5px] text-meta">{[c.channel ? CHANNEL_LABEL[c.channel] : null, c.format || null, c.owner || null].filter(Boolean).join(" · ")}</div>
                </div>
                {c.link && <a href={c.link} target="_blank" rel="noopener noreferrer" className="shrink-0 text-meta hover:text-foreground"><ExternalLink className="size-3.5" /></a>}
                <button onClick={() => { setEditDraft(toDraft(c)); setEditingId(c.id); }} className="shrink-0 text-meta hover:text-foreground"><Pencil className="size-3.5" /></button>
                <button onClick={() => remove(c.id)} className="shrink-0 text-meta hover:text-foreground"><Trash2 className="size-3.5" /></button>
              </div>
            )
          ))}
        </div>
      )}
    </main>
  );
}
