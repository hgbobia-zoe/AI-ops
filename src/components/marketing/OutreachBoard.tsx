"use client";

// Marketing outreach — the top-of-funnel prospect tracker. These are people/orgs the team is reaching
// out to BEFORE Goodshuffle. The win is "Quote agreed": the moment they agree to a quote they cross into
// Goodshuffle and Sales OS takes over, so they leave this board as a win. Goodshuffle leads are never
// tracked here. Manual, deterministic, no fabrication.

import { useEffect, useMemo, useState } from "react";
import { Plus, Pencil, Trash2, Loader2, Check, X, Send, Trophy, ArrowRight } from "lucide-react";
import {
  OUTREACH_SOURCES, OUTREACH_SOURCE_LABEL, AUDIENCES, AUDIENCE_LABEL,
  PROSPECT_STATUS_ORDER, PROSPECT_STATUS_LABEL, PROSPECT_OPEN_STAGES, isProspectWon,
  type Prospect, type ProspectInput, type OutreachSource, type Audience, type ProspectStatus,
} from "@/lib/marketing/types";

const INPUT = "w-full rounded border border-border bg-background px-2.5 py-1.5 text-[13px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const BTN = "inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50";
const STATUS_STYLE: Record<ProspectStatus, string> = {
  to_contact: "border-border text-meta",
  contacted: "border-accent-foreground/30 text-tertiary-text",
  responded: "border-attention/40 text-attention",
  quote_agreed: "border-positive/50 text-positive",
  not_interested: "border-border text-meta line-through",
};

const OPEN_SET = new Set<ProspectStatus>(PROSPECT_OPEN_STAGES);

function emptyDraft(): ProspectInput { return { name: "", contact: "", audience: "b2c", source: null, status: "to_contact", owner: "", nextAction: null, notes: "" }; }
function toDraft(p: Prospect): ProspectInput { return { name: p.name, contact: p.contact, audience: p.audience, source: p.source, status: p.status, owner: p.owner, nextAction: p.nextAction, notes: p.notes }; }

function Editor({ draft, setDraft, onSave, onCancel, saving }: { draft: ProspectInput; setDraft: (d: ProspectInput) => void; onSave: () => void; onCancel: () => void; saving: boolean }): React.JSX.Element {
  const set = <K extends keyof ProspectInput>(k: K, v: ProspectInput[K]) => setDraft({ ...draft, [k]: v });
  return (
    <div className="space-y-3 rounded border border-border bg-[var(--row-hover)]/40 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1"><span className="text-[11px] text-meta">Prospect (person or org)</span><input className={INPUT} value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="Glenview Mansion / Jordan Ellis" /></label>
        <label className="space-y-1"><span className="text-[11px] text-meta">Contact</span><input className={INPUT} value={draft.contact} onChange={(e) => set("contact", e.target.value)} placeholder="email / phone / @handle" /></label>
        <label className="space-y-1"><span className="text-[11px] text-meta">Audience</span>
          <select className={INPUT} value={draft.audience} onChange={(e) => set("audience", e.target.value as Audience)}>{AUDIENCES.map((a) => <option key={a} value={a}>{AUDIENCE_LABEL[a]}</option>)}</select>
        </label>
        <label className="space-y-1"><span className="text-[11px] text-meta">Source / channel</span>
          <select className={INPUT} value={draft.source ?? ""} onChange={(e) => set("source", (e.target.value || null) as OutreachSource | null)}><option value="">—</option>{OUTREACH_SOURCES.map((s) => <option key={s} value={s}>{OUTREACH_SOURCE_LABEL[s]}</option>)}</select>
        </label>
        <label className="space-y-1"><span className="text-[11px] text-meta">Status</span>
          <select className={INPUT} value={draft.status} onChange={(e) => set("status", e.target.value as ProspectStatus)}>{PROSPECT_STATUS_ORDER.map((s) => <option key={s} value={s}>{PROSPECT_STATUS_LABEL[s]}</option>)}</select>
        </label>
        <label className="space-y-1"><span className="text-[11px] text-meta">Next touch</span><input type="date" className={INPUT} value={draft.nextAction ?? ""} onChange={(e) => set("nextAction", e.target.value || null)} /></label>
        <label className="space-y-1 sm:col-span-2"><span className="text-[11px] text-meta">Owner</span><input className={INPUT} value={draft.owner} onChange={(e) => set("owner", e.target.value)} /></label>
        <label className="space-y-1 sm:col-span-2"><span className="text-[11px] text-meta">Notes</span><textarea className={INPUT} rows={2} value={draft.notes} onChange={(e) => set("notes", e.target.value)} /></label>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={onSave} disabled={saving || !draft.name?.trim()} className={BTN + " border-foreground text-foreground"}>{saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Save</button>
        <button onClick={onCancel} className={BTN}><X className="size-3.5" /> Cancel</button>
      </div>
    </div>
  );
}

type Filter = "open" | "won" | "all";

export function OutreachBoard(): React.JSX.Element {
  const [prospects, setProspects] = useState<Prospect[] | null>(null);
  const [filter, setFilter] = useState<Filter>("open");
  const [audienceFilter, setAudienceFilter] = useState<"all" | Audience>("all");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<ProspectInput>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<ProspectInput>(emptyDraft);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/marketing/prospects").then((r) => r.json()).then((j: { prospects?: Prospect[] }) => setProspects(j.prospects ?? [])).catch(() => setProspects([]));
  }, []);

  
  const counts = useMemo(() => {
    const c = { open: 0, won: 0, all: (prospects ?? []).length };
    for (const p of prospects ?? []) { if (OPEN_SET.has(p.status)) c.open++; if (isProspectWon(p.status)) c.won++; }
    return c;
  }, [prospects]);

  const shown = useMemo(() => (prospects ?? []).filter((p) => {
    const byStage = filter === "all" ? true : filter === "won" ? isProspectWon(p.status) : OPEN_SET.has(p.status);
    const byAud = audienceFilter === "all" || p.audience === audienceFilter || p.audience === "both";
    return byStage && byAud;
  }), [prospects, filter, audienceFilter]);

  async function reload() { const j = (await (await fetch("/api/marketing/prospects")).json()) as { prospects?: Prospect[] }; setProspects(j.prospects ?? []); }
  async function create() { setSaving(true); try { const r = await fetch("/api/marketing/prospects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) }); if (r.ok) { setAdding(false); setDraft(emptyDraft()); await reload(); } } finally { setSaving(false); } }
  async function saveEdit(id: string) { setSaving(true); try { const r = await fetch(`/api/marketing/prospects/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(editDraft) }); if (r.ok) { setEditingId(null); await reload(); } } finally { setSaving(false); } }
  async function setStatus(id: string, status: ProspectStatus) {
    setProspects((prev) => (prev ?? []).map((p) => (p.id === id ? { ...p, status } : p)));
    await fetch(`/api/marketing/prospects/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
    await reload();
  }
  async function remove(id: string) { if (!window.confirm("Delete this prospect?")) return; await fetch(`/api/marketing/prospects/${id}`, { method: "DELETE" }); await reload(); }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <main className="max-w-[1000px] p-6">
      <div className="mb-4 text-[12px] text-meta"><span className="text-meta">Marketing</span> / Outreach</div>
      <header className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight"><Send className="size-5 text-meta" /> Outreach</h1>
          <p className="mt-1 max-w-prose text-[12.5px] text-meta">Prospects the team is reaching out to before Goodshuffle. The win is a <span className="text-positive">quote agreed</span> — at that point they become a Goodshuffle lead and Sales OS takes over.</p>
        </div>
        {!adding && <button onClick={() => { setDraft(emptyDraft()); setAdding(true); }} className={BTN + " border-foreground text-foreground"}><Plus className="size-3.5" /> Add prospect</button>}
      </header>

      {/* Funnel summary */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(["open", "won", "all"] as Filter[]).map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={`rounded border px-2.5 py-1 text-[12.5px] transition-colors ${filter === f ? "border-foreground bg-foreground/10 font-medium text-foreground" : "border-border text-meta hover:bg-[var(--row-hover)]"}`}>
            {f === "open" ? "Open" : f === "won" ? <span className="inline-flex items-center gap-1"><Trophy className="size-3" /> Quotes won</span> : "All"} <span className="tabular-nums text-meta">{counts[f]}</span>
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-border" />
        <select value={audienceFilter} onChange={(e) => setAudienceFilter(e.target.value as "all" | Audience)} className="rounded border border-border bg-background px-2 py-1 text-[12.5px] text-tertiary-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <option value="all">All audiences</option>
          {AUDIENCES.filter((a) => a !== "both").map((a) => <option key={a} value={a}>{AUDIENCE_LABEL[a]}</option>)}
        </select>
      </div>

      {adding && <div className="mb-4"><Editor draft={draft} setDraft={setDraft} onSave={create} onCancel={() => setAdding(false)} saving={saving} /></div>}

      {prospects === null ? (
        <div className="flex items-center gap-2 text-[13px] text-meta"><Loader2 className="size-4 animate-spin" /> Loading…</div>
      ) : shown.length === 0 ? (
        <p className="text-[13px] text-meta">{filter === "won" ? "No quotes agreed yet. Keep the outreach going." : "No prospects here yet. Add someone you're reaching out to."}</p>
      ) : (
        <div className="space-y-2">
          {shown.map((p) => (
            editingId === p.id ? (
              <Editor key={p.id} draft={editDraft} setDraft={setEditDraft} onSave={() => saveEdit(p.id)} onCancel={() => setEditingId(null)} saving={saving} />
            ) : (
              <div key={p.id} className={`rounded border p-3 ${isProspectWon(p.status) ? "border-positive/40 bg-positive/[0.04]" : "border-border"}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{p.name}</span>
                      <span className="text-[11px] text-meta">{AUDIENCE_LABEL[p.audience]}</span>
                      {p.source && <span className="text-[11px] text-meta">· {OUTREACH_SOURCE_LABEL[p.source]}</span>}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-meta">
                      {p.contact && <span>{p.contact}</span>}
                      {p.owner && <span>{p.owner}</span>}
                      {p.nextAction && !isProspectWon(p.status) && <span className={p.nextAction < today ? "text-attention" : ""}>next {p.nextAction}</span>}
                      {isProspectWon(p.status) && p.wonAt && <span className="text-positive">won {p.wonAt.slice(0, 10)}</span>}
                    </div>
                    {p.notes && <p className="mt-1 text-[12.5px] text-tertiary-text">{p.notes}</p>}
                    {isProspectWon(p.status) && <p className="mt-1 inline-flex items-center gap-1 text-[11.5px] text-positive"><ArrowRight className="size-3" /> Now a Goodshuffle lead — continue in Sales OS.</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <select value={p.status} onChange={(e) => setStatus(p.id, e.target.value as ProspectStatus)} className={`rounded border bg-background px-1.5 py-1 text-[11.5px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${STATUS_STYLE[p.status]}`}>
                      {PROSPECT_STATUS_ORDER.map((s) => <option key={s} value={s}>{PROSPECT_STATUS_LABEL[s]}</option>)}
                    </select>
                    <button onClick={() => { setEditDraft(toDraft(p)); setEditingId(p.id); }} className={BTN}><Pencil className="size-3.5" /></button>
                    <button onClick={() => remove(p.id)} className={BTN}><Trash2 className="size-3.5" /></button>
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
