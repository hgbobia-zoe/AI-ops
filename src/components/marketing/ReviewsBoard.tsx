"use client";

// Marketing reviews & reputation — log and track reviews from Google, The Knot, WeddingWire and the
// rest, flag which still need a reply, and keep the average visible. Manual today; a Google Business /
// directory pull can populate this later. Deterministic, no fabrication.

import { useEffect, useMemo, useState } from "react";
import { Plus, Pencil, Trash2, Loader2, Check, X, Star, ExternalLink } from "lucide-react";
import { REVIEW_SOURCES, REVIEW_SOURCE_LABEL, type Review, type ReviewInput, type ReviewSource } from "@/lib/marketing/types";

const INPUT = "w-full rounded border border-border bg-background px-2.5 py-1.5 text-[13px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const BTN = "inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50";

function emptyDraft(): ReviewInput { return { source: "google", reviewer: "", rating: 5, reviewDate: null, text: "", responded: false, responseNote: "", link: "" }; }
function toDraft(r: Review): ReviewInput { return { source: r.source, reviewer: r.reviewer, rating: r.rating, reviewDate: r.reviewDate, text: r.text, responded: r.responded, responseNote: r.responseNote, link: r.link }; }

function Editor({ draft, setDraft, onSave, onCancel, saving }: { draft: ReviewInput; setDraft: (d: ReviewInput) => void; onSave: () => void; onCancel: () => void; saving: boolean }): React.JSX.Element {
  const set = <K extends keyof ReviewInput>(k: K, v: ReviewInput[K]) => setDraft({ ...draft, [k]: v });
  return (
    <div className="space-y-3 rounded border border-border bg-[var(--row-hover)]/40 p-3">
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="space-y-1"><span className="text-[11px] text-meta">Source</span>
          <select className={INPUT} value={draft.source} onChange={(e) => set("source", e.target.value as ReviewSource)}>{REVIEW_SOURCES.map((s) => <option key={s} value={s}>{REVIEW_SOURCE_LABEL[s]}</option>)}</select>
        </label>
        <label className="space-y-1"><span className="text-[11px] text-meta">Reviewer</span><input className={INPUT} value={draft.reviewer} onChange={(e) => set("reviewer", e.target.value)} /></label>
        <label className="space-y-1"><span className="text-[11px] text-meta">Rating</span>
          <select className={INPUT} value={draft.rating ?? ""} onChange={(e) => set("rating", e.target.value === "" ? null : Number(e.target.value))}><option value="">—</option>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} ★</option>)}</select>
        </label>
        <label className="space-y-1"><span className="text-[11px] text-meta">Date</span><input type="date" className={INPUT} value={draft.reviewDate ?? ""} onChange={(e) => set("reviewDate", e.target.value || null)} /></label>
      </div>
      <label className="block space-y-1"><span className="text-[11px] text-meta">Review text</span><textarea className={INPUT} rows={2} value={draft.text} onChange={(e) => set("text", e.target.value)} /></label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex items-center gap-2 pt-5 text-[13px]"><input type="checkbox" className="size-4 accent-foreground" checked={!!draft.responded} onChange={(e) => set("responded", e.target.checked)} /> Responded</label>
        <label className="space-y-1"><span className="text-[11px] text-meta">Link</span><input className={INPUT} value={draft.link} onChange={(e) => set("link", e.target.value)} placeholder="https://…" /></label>
      </div>
      {draft.responded && <label className="block space-y-1"><span className="text-[11px] text-meta">Response note</span><input className={INPUT} value={draft.responseNote} onChange={(e) => set("responseNote", e.target.value)} /></label>}
      <div className="flex items-center gap-2">
        <button onClick={onSave} disabled={saving} className={BTN + " border-foreground text-foreground"}>{saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Save</button>
        <button onClick={onCancel} className={BTN}><X className="size-3.5" /> Cancel</button>
      </div>
    </div>
  );
}

export function ReviewsBoard(): React.JSX.Element {
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<ReviewInput>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<ReviewInput>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [onlyUnanswered, setOnlyUnanswered] = useState(false);

  useEffect(() => {
    fetch("/api/marketing/reviews").then((r) => r.json()).then((j: { reviews?: Review[] }) => setReviews(j.reviews ?? [])).catch(() => setReviews([]));
  }, []);

  const rated = useMemo(() => (reviews ?? []).filter((r) => r.rating != null), [reviews]);
  const avg = rated.length ? Math.round((rated.reduce((s, r) => s + (r.rating ?? 0), 0) / rated.length) * 10) / 10 : null;
  const shown = useMemo(() => (reviews ?? []).filter((r) => !onlyUnanswered || !r.responded), [reviews, onlyUnanswered]);

  async function reload() { const j = (await (await fetch("/api/marketing/reviews")).json()) as { reviews?: Review[] }; setReviews(j.reviews ?? []); }
  async function create() { setSaving(true); try { const r = await fetch("/api/marketing/reviews", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) }); if (r.ok) { setAdding(false); setDraft(emptyDraft()); await reload(); } } finally { setSaving(false); } }
  async function saveEdit(id: string) { setSaving(true); try { const r = await fetch(`/api/marketing/reviews/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(editDraft) }); if (r.ok) { setEditingId(null); await reload(); } } finally { setSaving(false); } }
  async function remove(id: string) { if (!window.confirm("Delete this review?")) return; await fetch(`/api/marketing/reviews/${id}`, { method: "DELETE" }); await reload(); }

  return (
    <main className="max-w-[1000px] p-6">
      <div className="mb-4 text-[12px] text-meta"><span className="text-meta">Marketing</span> / Reviews</div>
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight"><Star className="size-5 text-meta" /> Reviews &amp; reputation</h1>
          <p className="mt-1 text-[12.5px] text-meta">{avg != null ? `${avg}★ average across ${rated.length} rated` : "No ratings yet"}. Manual today; a Google Business pull can populate this later.</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[12px] text-meta"><input type="checkbox" className="size-3.5 accent-foreground" checked={onlyUnanswered} onChange={(e) => setOnlyUnanswered(e.target.checked)} /> Needs reply</label>
          {!adding && <button onClick={() => { setDraft(emptyDraft()); setAdding(true); }} className={BTN + " border-foreground text-foreground"}><Plus className="size-3.5" /> Add review</button>}
        </div>
      </header>

      {adding && <div className="mb-4"><Editor draft={draft} setDraft={setDraft} onSave={create} onCancel={() => setAdding(false)} saving={saving} /></div>}

      {reviews === null ? (
        <div className="flex items-center gap-2 text-[13px] text-meta"><Loader2 className="size-4 animate-spin" /> Loading…</div>
      ) : shown.length === 0 ? (
        <p className="text-[13px] text-meta">{onlyUnanswered ? "No reviews awaiting a reply." : "No reviews logged yet."}</p>
      ) : (
        <div className="space-y-2">
          {shown.map((r) => (
            editingId === r.id ? (
              <Editor key={r.id} draft={editDraft} setDraft={setEditDraft} onSave={() => saveEdit(r.id)} onCancel={() => setEditingId(null)} saving={saving} />
            ) : (
              <div key={r.id} className="rounded border border-border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-[13px]">
                      <span className="tabular-nums text-attention">{r.rating != null ? `${r.rating}★` : "—"}</span>
                      <span className="font-medium text-foreground">{r.reviewer || "Anonymous"}</span>
                      <span className="text-[11px] text-meta">{REVIEW_SOURCE_LABEL[r.source]}</span>
                      {r.reviewDate && <span className="text-[11px] text-meta">{r.reviewDate}</span>}
                      {!r.responded ? <span className="rounded border border-attention/40 px-1.5 py-px text-[10px] uppercase tracking-[0.05em] text-attention">Needs reply</span> : <span className="rounded border border-positive/40 px-1.5 py-px text-[10px] uppercase tracking-[0.05em] text-positive">Replied</span>}
                    </div>
                    {r.text && <p className="mt-1 text-[12.5px] text-tertiary-text">{r.text}</p>}
                    {r.responded && r.responseNote && <p className="mt-1 text-[11.5px] text-meta">Reply: {r.responseNote}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {r.link && <a href={r.link} target="_blank" rel="noopener noreferrer" className={BTN}><ExternalLink className="size-3.5" /></a>}
                    <button onClick={() => { setEditDraft(toDraft(r)); setEditingId(r.id); }} className={BTN}><Pencil className="size-3.5" /></button>
                    <button onClick={() => remove(r.id)} className={BTN}><Trash2 className="size-3.5" /></button>
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
