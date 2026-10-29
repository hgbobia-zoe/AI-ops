"use client";

// Marketing — Reviews & reputation. The team LOGS reviews here (from Google, The Knot, WeddingWire,
// Yelp, Facebook or a direct note), tracks which still need a reply, and keeps the logged average
// visible. It is deliberately honest about scope: this page reflects only what has been logged in this
// workspace. There is no connection that pulls external published reviews in, so a low count here does
// NOT mean few reviews exist out in the world — and review requests + private customer feedback live in
// the Post-Event follow-up, not here. Manual + deterministic; no fabrication.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Plus, Pencil, Trash2, Loader2, Check, X, Star, ExternalLink, ChevronDown, Search, MessageSquareReply,
} from "lucide-react";
import {
  REVIEW_SOURCES, REVIEW_SOURCE_LABEL, type Review, type ReviewInput, type ReviewSource,
} from "@/lib/marketing/types";
import {
  MAX_RATING, ratingLabel, starFills, responseState, nextAction, summarizeReviews, filterReviews,
  REVIEW_KIND, type SourceFilter, type RatingFilter,
} from "@/lib/marketing/reviews";
import { Button } from "@/components/ui/button";
import { PageHeader, Toolbar } from "@/components/ui/page-header";
import { BladeMain, WorkSurfaceLayout } from "@/components/ui/layouts";
import { Metric, MetricGrid } from "@/components/ui/metric";
import { EmptyState } from "@/components/ui/states";
import { Surface } from "@/components/ui/surface";
import { StatusBadge } from "@/components/ui/status";

const INPUT =
  "w-full rounded border border-border bg-background px-2.5 py-1.5 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const LABEL = "text-[11px] text-meta";

function emptyDraft(): ReviewInput {
  return { source: "google", reviewer: "", rating: 5, reviewDate: null, text: "", responded: false, responseNote: "", link: "" };
}
function toDraft(r: Review): ReviewInput {
  return { source: r.source, reviewer: r.reviewer, rating: r.rating, reviewDate: r.reviewDate, text: r.text, responded: r.responded, responseNote: r.responseNote, link: r.link };
}

/** A readable, accessible star row. The visual stars are decorative; the label carries the meaning. */
function Stars({ rating }: { rating: number | null }): React.JSX.Element {
  const fills = starFills(rating);
  return (
    <span className="inline-flex items-center gap-0.5" role="img" aria-label={ratingLabel(rating)}>
      {rating == null ? (
        <span className="text-[12px] text-meta" aria-hidden>Unrated</span>
      ) : (
        fills.map((on, i) => (
          <Star
            key={i}
            className={on ? "size-3.5 fill-status-warning text-status-warning" : "size-3.5 text-meta/40"}
            aria-hidden
          />
        ))
      )}
    </span>
  );
}

function Editor({
  draft, setDraft, onSave, onCancel, saving, idBase,
}: {
  draft: ReviewInput; setDraft: (d: ReviewInput) => void; onSave: () => void; onCancel: () => void; saving: boolean; idBase: string;
}): React.JSX.Element {
  const set = <K extends keyof ReviewInput>(k: K, v: ReviewInput[K]) => setDraft({ ...draft, [k]: v });
  return (
    <div className="space-y-3 rounded border border-border bg-row p-3">
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="space-y-1">
          <span className={LABEL}>Source</span>
          <select className={INPUT} value={draft.source} onChange={(e) => set("source", e.target.value as ReviewSource)}>
            {REVIEW_SOURCES.map((s) => <option key={s} value={s}>{REVIEW_SOURCE_LABEL[s]}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className={LABEL}>Reviewer</span>
          <input className={INPUT} value={draft.reviewer ?? ""} onChange={(e) => set("reviewer", e.target.value)} placeholder="Name (optional)" />
        </label>
        <label className="space-y-1">
          <span className={LABEL}>Rating</span>
          <select className={INPUT} value={draft.rating ?? ""} onChange={(e) => set("rating", e.target.value === "" ? null : Number(e.target.value))}>
            <option value="">No rating</option>
            {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} out of {MAX_RATING}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className={LABEL}>Date</span>
          <input type="date" className={INPUT} value={draft.reviewDate ?? ""} onChange={(e) => set("reviewDate", e.target.value || null)} />
        </label>
      </div>
      <label className="block space-y-1">
        <span className={LABEL}>Review text</span>
        <textarea className={INPUT} rows={3} value={draft.text ?? ""} onChange={(e) => set("text", e.target.value)} placeholder="Paste the review as written" />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex items-center gap-2 pt-5 text-[13px] text-foreground">
          <input type="checkbox" className="size-4 accent-foreground" checked={!!draft.responded} onChange={(e) => set("responded", e.target.checked)} />
          Marked as replied
        </label>
        <label className="space-y-1">
          <span className={LABEL}>Link to original review</span>
          <input className={INPUT} value={draft.link ?? ""} onChange={(e) => set("link", e.target.value)} placeholder="https://…" />
        </label>
      </div>
      {draft.responded && (
        <label className="block space-y-1">
          <span className={LABEL}>Response note (what was said / who replied)</span>
          <input className={INPUT} value={draft.responseNote ?? ""} onChange={(e) => set("responseNote", e.target.value)} />
        </label>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onSave} disabled={saving}>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Save
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={saving} aria-controls={idBase}>
          <X className="size-3.5" /> Cancel
        </Button>
      </div>
    </div>
  );
}

/** One logged review: a scannable summary row that expands to the full detail + response workflow. */
function ReviewRow({
  r, expanded, onToggle, editing, onEdit, onCancelEdit, onSaveEdit, onDelete, editDraft, setEditDraft, saving,
}: {
  r: Review; expanded: boolean; onToggle: () => void;
  editing: boolean; onEdit: () => void; onCancelEdit: () => void; onSaveEdit: () => void; onDelete: () => void;
  editDraft: ReviewInput; setEditDraft: (d: ReviewInput) => void; saving: boolean;
}): React.JSX.Element {
  const state = responseState(r);
  const action = nextAction(r);
  const detailId = `review-detail-${r.id}`;
  return (
    <div className="surface border border-border">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={detailId}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Stars rating={r.rating} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
            <span className="font-medium text-foreground">{r.reviewer || "Anonymous"}</span>
            <span className="text-[12px] text-meta">{REVIEW_SOURCE_LABEL[r.source]}</span>
            {r.reviewDate && <span className="text-[12px] text-meta tabular-nums">{r.reviewDate}</span>}
          </span>
          {r.text && <span className="mt-0.5 line-clamp-1 block text-[12px] text-tertiary-text">{r.text}</span>}
        </span>
        <StatusBadge tone={state.tone} size="sm" className="shrink-0">{state.label}</StatusBadge>
        <ChevronDown className={`size-4 shrink-0 text-meta transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden />
      </button>

      {expanded && (
        <div id={detailId} className="border-t border-rule px-3 py-3">
          {editing ? (
            <Editor draft={editDraft} setDraft={setEditDraft} onSave={onSaveEdit} onCancel={onCancelEdit} saving={saving} idBase={detailId} />
          ) : (
            <div className="space-y-3 text-[13px]">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="inline-flex items-center gap-1.5"><Stars rating={r.rating} /><span className="text-[12px] text-meta">{ratingLabel(r.rating)}</span></span>
                {action.label && (
                  <span className="inline-flex items-center gap-1.5 text-[12px] text-secondary-text">
                    <MessageSquareReply className="size-3.5 text-status-warning" aria-hidden /> Next: {action.label}
                  </span>
                )}
              </div>

              <div>
                <div className={LABEL}>Review text</div>
                <p className="mt-0.5 whitespace-pre-wrap text-[13px] text-foreground">{r.text || <span className="text-meta">No text recorded</span>}</p>
              </div>

              <div>
                <div className={LABEL}>Response</div>
                {r.responded ? (
                  <p className="mt-0.5 text-[13px] text-foreground">
                    Replied{r.responseNote ? <>: <span className="text-secondary-text">{r.responseNote}</span></> : <span className="text-meta"> (no note recorded)</span>}
                  </p>
                ) : (
                  <p className="mt-0.5 text-[13px] text-secondary-text">Not replied yet. The app does not post replies — respond on the source, then mark it replied here.</p>
                )}
              </div>

              <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
                <div>
                  <div className={LABEL}>Source</div>
                  <div className="mt-0.5 flex items-center gap-2 text-[13px] text-foreground">
                    {REVIEW_SOURCE_LABEL[r.source]}
                    {r.link ? (
                      <a href={r.link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[12px] text-meta hover:text-foreground">
                        <ExternalLink className="size-3.5" /> Open original
                      </a>
                    ) : (
                      <span className="text-[12px] text-meta">No link recorded</span>
                    )}
                  </div>
                </div>
                <div>
                  <div className={LABEL}>Related event</div>
                  {/* The data model has no review→event mapping, so this is honestly unknown — never fabricated. */}
                  <div className="mt-0.5 text-[13px] text-meta">Not linked</div>
                </div>
              </div>

              <div className={LABEL}>
                Logged {r.createdAt.slice(0, 10)}
                {r.updatedAt.slice(0, 10) !== r.createdAt.slice(0, 10) && <> · updated {r.updatedAt.slice(0, 10)}</>}
              </div>

              <div className="flex items-center gap-2 pt-1">
                <Button size="sm" variant="outline" onClick={onEdit}><Pencil className="size-3.5" /> Edit</Button>
                <Button size="sm" variant="destructive" onClick={onDelete}><Trash2 className="size-3.5" /> Delete</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ReviewsBoard(): React.JSX.Element {
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<ReviewInput>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<ReviewInput>(emptyDraft);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Filters
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");
  const [rating, setRating] = useState<RatingFilter>("all");
  const [onlyUnanswered, setOnlyUnanswered] = useState(false);

  useEffect(() => {
    fetch("/api/marketing/reviews")
      .then((r) => r.json())
      .then((j: { reviews?: Review[] }) => setReviews(j.reviews ?? []))
      .catch(() => { setReviews([]); setLoadError(true); });
  }, []);

  const all = useMemo(() => reviews ?? [], [reviews]);
  const summary = useMemo(() => summarizeReviews(all), [all]);
  const shown = useMemo(
    () => filterReviews(all, { query, source, rating, onlyUnanswered }),
    [all, query, source, rating, onlyUnanswered],
  );
  const filtersActive = query.trim() !== "" || source !== "all" || rating !== "all" || onlyUnanswered;

  async function reload() {
    const j = (await (await fetch("/api/marketing/reviews")).json()) as { reviews?: Review[] };
    setReviews(j.reviews ?? []);
  }
  async function create() {
    setSaving(true);
    try {
      const r = await fetch("/api/marketing/reviews", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
      if (r.ok) { setAdding(false); setDraft(emptyDraft()); await reload(); }
    } finally { setSaving(false); }
  }
  async function saveEdit(id: string) {
    setSaving(true);
    try {
      const r = await fetch(`/api/marketing/reviews/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(editDraft) });
      if (r.ok) { setEditingId(null); await reload(); }
    } finally { setSaving(false); }
  }
  async function remove(id: string) {
    if (!window.confirm("Delete this logged review? This cannot be undone.")) return;
    await fetch(`/api/marketing/reviews/${id}`, { method: "DELETE" });
    if (expandedId === id) setExpandedId(null);
    await reload();
  }

  const addBtn = !adding && (
    <Button size="sm" onClick={() => { setDraft(emptyDraft()); setAdding(true); }}>
      <Plus className="size-3.5" /> Log a review
    </Button>
  );

  return (
    <BladeMain className="max-w-[1100px]">
      <nav className="mb-3 text-[12px] text-meta" aria-label="Breadcrumb">
        <Link href="/marketing" className="hover:text-foreground">Marketing</Link> / Reviews
      </nav>

      <PageHeader
        icon={<Star className="size-5" />}
        title="Reviews & reputation"
        subtitle="Reviews the team has logged in this workspace. This is not a live feed of your public reputation."
        actions={addBtn}
      />

      {/* Scope — the four distinct concepts, kept apart so no single number misleads. */}
      <Surface pad="none" className="mb-4 p-3.5 text-[12.5px]">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-meta">What this page tracks</div>
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          <div>
            <dt className="font-medium text-foreground">{REVIEW_KIND.logged.label}</dt>
            <dd className="text-secondary-text">{REVIEW_KIND.logged.note}</dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">{REVIEW_KIND.external.label}</dt>
            <dd className="text-secondary-text">{REVIEW_KIND.external.note}</dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">{REVIEW_KIND.request.label}</dt>
            <dd className="text-secondary-text">
              {REVIEW_KIND.request.note} <Link href="/postevent" className="text-meta underline-offset-2 hover:text-foreground hover:underline">Open Post-Event</Link>
            </dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">{REVIEW_KIND.feedback.label}</dt>
            <dd className="text-secondary-text">{REVIEW_KIND.feedback.note}</dd>
          </div>
        </dl>
      </Surface>

      {/* Logged-only figures — each label says so, so no tile reads as a reputation total. */}
      <MetricGrid className="mb-4">
        <Metric label="LOGGED REVIEWS" value={reviews === null ? "—" : summary.logged} sub="entered in this workspace" />
        <Metric label="AVERAGE RATING" value={summary.avgRating != null ? `${summary.avgRating}★` : "—"} sub={summary.rated ? `across ${summary.rated} rated · logged only` : "no rated reviews yet"} />
        <Metric label="AWAITING REPLY" value={reviews === null ? "—" : summary.unresponded} sub="logged reviews not yet replied" tone={summary.unresponded > 0 ? "attention" : "neutral"} />
        <Metric label="REPLIED" value={reviews === null ? "—" : summary.replied} sub="logged reviews marked replied" tone={summary.replied > 0 ? "positive" : "neutral"} />
      </MetricGrid>

      {adding && <div className="mb-4"><Editor draft={draft} setDraft={setDraft} onSave={create} onCancel={() => setAdding(false)} saving={saving} idBase="add-review" /></div>}

      <WorkSurfaceLayout
        toolbar={
          <Toolbar>
            <div className="flex flex-wrap items-center gap-2">
              <label className="relative">
                <span className="sr-only">Search logged reviews</span>
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-meta" aria-hidden />
                <input className={INPUT + " w-[200px] pl-7"} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search reviewer or text" />
              </label>
              <label className="flex items-center gap-1.5 text-[12px] text-meta">
                <span className="sr-only sm:not-sr-only">Source</span>
                <select className={INPUT + " w-auto"} value={source} onChange={(e) => setSource(e.target.value as SourceFilter)} aria-label="Filter by source">
                  <option value="all">All sources</option>
                  {REVIEW_SOURCES.map((s) => <option key={s} value={s}>{REVIEW_SOURCE_LABEL[s]}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-1.5 text-[12px] text-meta">
                <span className="sr-only sm:not-sr-only">Rating</span>
                <select className={INPUT + " w-auto"} value={String(rating)} onChange={(e) => { const v = e.target.value; setRating(v === "all" || v === "unrated" ? v : Number(v)); }} aria-label="Filter by rating">
                  <option value="all">All ratings</option>
                  {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} stars</option>)}
                  <option value="unrated">Unrated</option>
                </select>
              </label>
              <label className="flex items-center gap-1.5 text-[12px] text-secondary-text">
                <input type="checkbox" className="size-3.5 accent-foreground" checked={onlyUnanswered} onChange={(e) => setOnlyUnanswered(e.target.checked)} />
                Needs reply
              </label>
            </div>
            <span className="text-[12px] text-meta tabular-nums">
              {reviews === null ? "" : filtersActive ? `${shown.length} of ${summary.logged} shown` : `${summary.logged} logged`}
            </span>
          </Toolbar>
        }
      >
        {reviews === null ? (
          <div className="flex items-center gap-2 py-8 text-[13px] text-meta"><Loader2 className="size-4 animate-spin" aria-hidden /> Loading logged reviews…</div>
        ) : all.length === 0 ? (
          <EmptyState
            icon={<Star className="size-6" />}
            title="No reviews logged in this workspace yet"
            body={
              <>
                This is empty because nothing has been entered here — not because you have no reviews.
                Zoe&apos;s reviews on Google, The Knot and elsewhere still exist; the app does not pull them in.
                Log one to start tracking replies and your logged average.
              </>
            }
            action={<Button size="sm" onClick={() => { setDraft(emptyDraft()); setAdding(true); }}><Plus className="size-3.5" /> Log a review</Button>}
          />
        ) : shown.length === 0 ? (
          <div className="surface border border-border px-4 py-10 text-center text-[13px] text-meta">
            No logged reviews match these filters.
            <div className="mt-2">
              <Button size="sm" variant="outline" onClick={() => { setQuery(""); setSource("all"); setRating("all"); setOnlyUnanswered(false); }}>Clear filters</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {shown.map((r) => (
              <ReviewRow
                key={r.id}
                r={r}
                expanded={expandedId === r.id}
                onToggle={() => { setExpandedId(expandedId === r.id ? null : r.id); if (editingId !== r.id) setEditingId(null); }}
                editing={editingId === r.id}
                onEdit={() => { setEditDraft(toDraft(r)); setEditingId(r.id); setExpandedId(r.id); }}
                onCancelEdit={() => setEditingId(null)}
                onSaveEdit={() => saveEdit(r.id)}
                onDelete={() => remove(r.id)}
                editDraft={editDraft}
                setEditDraft={setEditDraft}
                saving={saving}
              />
            ))}
          </div>
        )}

        {loadError && <p className="mt-3 text-[12px] text-status-warning">Could not load reviews. Showing an empty list.</p>}
      </WorkSurfaceLayout>
    </BladeMain>
  );
}
