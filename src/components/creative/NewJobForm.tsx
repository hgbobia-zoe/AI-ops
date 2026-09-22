"use client";

// The New Creative Job form. Two blocks: Asset (what/where/how big) and Source (the THREE visually-obvious
// modes) with the reference-first PRESERVE / TRANSFORM editors prefilled from sensible defaults. Submitting
// creates the job and runs the Art Director. No raw prompt box — every field is structured input.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload, ImageIcon, Sparkles, Check, X, Loader2 } from "lucide-react";
import {
  ASSET_TYPES,
  ASSET_TYPE_LABEL,
  ASPECT_RATIOS,
  ASPECT_RATIO_LABEL,
  SOURCE_MODES,
  SOURCE_MODE_LABEL,
  SOURCE_MODE_HELP,
  PRESERVABLE,
  TRANSFORMABLE,
  defaultPreserve,
  defaultTransform,
  isReferenceFirst,
  type AssetType,
  type AspectRatio,
  type SourceMode,
  type CreativeImage,
} from "@/lib/creative/types";

const SOURCE_ICON: Record<SourceMode, typeof Upload> = { upload: Upload, existing: ImageIcon, scratch: Sparkles };

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.06em] text-meta">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-meta">{hint}</span>}
    </label>
  );
}

const inputCls =
  "w-full rounded border border-border bg-card px-2.5 py-1.5 text-[12.5px] text-foreground outline-none placeholder:text-meta focus:border-foreground/30";

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[11.5px] transition-colors ${
        active ? "border-foreground/40 bg-foreground/10 text-foreground" : "border-border text-tertiary-text hover:bg-[var(--row-hover)]"
      }`}
    >
      {active && <Check className="size-3" />}
      {children}
    </button>
  );
}

export function NewJobForm({ selectableImages }: { selectableImages: CreativeImage[] }): React.JSX.Element {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [assetType, setAssetType] = useState<AssetType>("lifestyle");
  const [page, setPage] = useState("");
  const [section, setSection] = useState("");
  const [product, setProduct] = useState("");
  const [productCategory, setProductCategory] = useState("");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("3:2");
  const [targetAudience, setTargetAudience] = useState("");
  const [campaign, setCampaign] = useState("");
  const [season, setSeason] = useState("");
  const [locationContext, setLocationContext] = useState("");
  const [objective, setObjective] = useState("");
  const [visualDirection, setVisualDirection] = useState("");

  const [sourceMode, setSourceMode] = useState<SourceMode>("scratch");
  const [sourceImageId, setSourceImageId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState<CreativeImage[]>([]);

  const [preserve, setPreserve] = useState<string[]>([]);
  const [transform, setTransform] = useState<string[]>(defaultTransform("lifestyle"));
  const [touchedPT, setTouchedPT] = useState(false);
  const [customPreserve, setCustomPreserve] = useState("");
  const [customTransform, setCustomTransform] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const images = useMemo(() => [...uploaded, ...selectableImages], [uploaded, selectableImages]);
  const referenceFirst = isReferenceFirst(sourceMode);

  // When the user hasn't hand-edited PRESERVE/TRANSFORM, keep them synced to the sensible defaults.
  function applyDefaults(mode: SourceMode, type: AssetType): void {
    if (touchedPT) return;
    setPreserve(defaultPreserve(mode, type));
    setTransform(defaultTransform(type));
  }
  function onAssetType(v: AssetType): void {
    setAssetType(v);
    applyDefaults(sourceMode, v);
  }
  function onSourceMode(v: SourceMode): void {
    setSourceMode(v);
    if (v === "scratch") setSourceImageId(null);
    applyDefaults(v, assetType);
  }

  const toggle = (list: string[], setList: (v: string[]) => void, item: string): void => {
    setTouchedPT(true);
    setList(list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  };
  const addCustom = (raw: string, list: string[], setList: (v: string[]) => void, clear: () => void): void => {
    const v = raw.trim();
    if (!v) return;
    setTouchedPT(true);
    if (!list.includes(v)) setList([...list, v]);
    clear();
  };

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/creative/upload", { method: "POST", body: fd });
      const data = (await res.json()) as { ok?: boolean; image?: CreativeImage; error?: string };
      if (!res.ok || !data.image) {
        setError(data.error || "Upload failed");
      } else {
        setUploaded((u) => [data.image!, ...u]);
        setSourceImageId(data.image.id);
      }
    } catch {
      setError("Upload failed");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!title.trim()) {
      setError("Give the asset a title.");
      return;
    }
    if (referenceFirst && !sourceImageId) {
      setError(sourceMode === "upload" ? "Upload the source photo first." : "Select an existing image as the source.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/creative/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          assetType,
          page,
          section,
          product,
          productCategory,
          aspectRatio,
          targetAudience,
          campaign,
          season,
          locationContext,
          objective,
          visualDirection,
          sourceMode,
          sourceImageId: referenceFirst ? sourceImageId : null,
          preserve,
          transform,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; job?: { id: string }; error?: string };
      if (!res.ok || !data.job) {
        setError(data.error || "Could not create the job.");
        setSubmitting(false);
        return;
      }
      router.push(`/creative/${data.job.id}`);
    } catch {
      setError("Could not create the job.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {/* ── Asset ── */}
      <section className="rounded border border-border">
        <h2 className="border-b border-[var(--row-rule)] bg-panel px-3 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-tertiary-text">Asset</h2>
        <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Title">
              <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Homepage hero — spring tented reception" />
            </Field>
          </div>
          <Field label="Asset type">
            <select className={inputCls} value={assetType} onChange={(e) => onAssetType(e.target.value as AssetType)}>
              {ASSET_TYPES.map((t) => (
                <option key={t} value={t}>{ASSET_TYPE_LABEL[t]}</option>
              ))}
            </select>
          </Field>
          <Field label="Aspect ratio">
            <select className={inputCls} value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}>
              {ASPECT_RATIOS.map((r) => (
                <option key={r} value={r}>{ASPECT_RATIO_LABEL[r]}</option>
              ))}
            </select>
          </Field>
          <Field label="Page" hint="Where it will live (optional)">
            <input className={inputCls} value={page} onChange={(e) => setPage(e.target.value)} placeholder="Home" />
          </Field>
          <Field label="Section">
            <input className={inputCls} value={section} onChange={(e) => setSection(e.target.value)} placeholder="Above the fold" />
          </Field>
          <Field label="Product">
            <input className={inputCls} value={product} onChange={(e) => setProduct(e.target.value)} placeholder="Sailcloth tent" />
          </Field>
          <Field label="Product category">
            <input className={inputCls} value={productCategory} onChange={(e) => setProductCategory(e.target.value)} placeholder="Tents" />
          </Field>
          <Field label="Target audience">
            <input className={inputCls} value={targetAudience} onChange={(e) => setTargetAudience(e.target.value)} placeholder="Luxury wedding clients" />
          </Field>
          <Field label="Campaign">
            <input className={inputCls} value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="Spring 2026" />
          </Field>
          <Field label="Season">
            <input className={inputCls} value={season} onChange={(e) => setSeason(e.target.value)} placeholder="Late spring, golden hour" />
          </Field>
          <Field label="Location context">
            <input className={inputCls} value={locationContext} onChange={(e) => setLocationContext(e.target.value)} placeholder="Manicured estate lawn, DMV" />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Objective" hint="What the image should accomplish">
              <input className={inputCls} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="convey effortless luxury and scale" />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Visual direction" hint="Optional creative note for the Art Director">
              <textarea className={`${inputCls} min-h-[60px] resize-y`} value={visualDirection} onChange={(e) => setVisualDirection(e.target.value)} placeholder="Warm, unhurried, guests mid-conversation, tent glowing at dusk." />
            </Field>
          </div>
        </div>
      </section>

      {/* ── Source ── */}
      <section className="rounded border border-border">
        <h2 className="border-b border-[var(--row-rule)] bg-panel px-3 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-tertiary-text">Source</h2>
        <div className="p-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {SOURCE_MODES.map((m) => {
              const Icon = SOURCE_ICON[m];
              const active = sourceMode === m;
              return (
                <button
                  type="button"
                  key={m}
                  onClick={() => onSourceMode(m)}
                  className={`flex flex-col gap-1 rounded border p-3 text-left transition-colors ${
                    active ? "border-foreground/40 bg-foreground/[0.06]" : "border-border hover:bg-[var(--row-hover)]"
                  }`}
                >
                  <span className={`flex items-center gap-2 text-[12.5px] font-medium ${active ? "text-foreground" : "text-tertiary-text"}`}>
                    <Icon className="size-4" /> {SOURCE_MODE_LABEL[m]}
                  </span>
                  <span className="text-[11px] text-meta">{SOURCE_MODE_HELP[m]}</span>
                </button>
              );
            })}
          </div>

          {sourceMode === "upload" && (
            <div className="mt-3">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded border border-border px-3 py-2 text-[12.5px] text-foreground transition-colors hover:bg-[var(--row-hover)]">
                {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4 text-tertiary-text" />}
                {uploading ? "Uploading…" : "Choose a photo"}
                <input type="file" accept="image/*" className="hidden" onChange={onUpload} disabled={uploading} />
              </label>
            </div>
          )}

          {referenceFirst && images.length > 0 && (
            <div className="mt-3">
              <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.06em] text-meta">
                {sourceMode === "existing" ? "Pick the source of truth" : "Selected source"}
              </span>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                {images.map((img) => (
                  <button
                    type="button"
                    key={img.id}
                    onClick={() => setSourceImageId(img.id)}
                    className={`group relative overflow-hidden rounded border ${sourceImageId === img.id ? "border-foreground" : "border-border hover:border-foreground/40"}`}
                    title={img.name ?? img.id}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={img.path} alt={img.name ?? "source"} className="h-16 w-full object-cover" />
                    {sourceImageId === img.id && (
                      <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-foreground text-background">
                        <Check className="size-3" />
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
          {referenceFirst && images.length === 0 && (
            <p className="mt-3 text-[11.5px] text-meta">No images in the library yet. Upload one to use as the source of truth.</p>
          )}

          {/* PRESERVE / TRANSFORM */}
          {referenceFirst ? (
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-meta">Preserve <span className="normal-case text-meta">(the source is the truth)</span></div>
                <div className="flex flex-wrap gap-1.5">
                  {Array.from(new Set([...PRESERVABLE, ...preserve])).map((p) => (
                    <Chip key={p} active={preserve.includes(p)} onClick={() => toggle(preserve, setPreserve, p)}>{p}</Chip>
                  ))}
                </div>
                <div className="mt-2 flex gap-1.5">
                  <input className={inputCls} value={customPreserve} onChange={(e) => setCustomPreserve(e.target.value)} placeholder="Add a preserve rule" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustom(customPreserve, preserve, setPreserve, () => setCustomPreserve("")); } }} />
                </div>
              </div>
              <div>
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-meta">Transform <span className="normal-case text-meta">(AI may change)</span></div>
                <div className="flex flex-wrap gap-1.5">
                  {Array.from(new Set([...TRANSFORMABLE, ...transform])).map((t) => (
                    <Chip key={t} active={transform.includes(t)} onClick={() => toggle(transform, setTransform, t)}>{t}</Chip>
                  ))}
                </div>
                <div className="mt-2 flex gap-1.5">
                  <input className={inputCls} value={customTransform} onChange={(e) => setCustomTransform(e.target.value)} placeholder="Add a transform" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustom(customTransform, transform, setTransform, () => setCustomTransform("")); } }} />
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-4">
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-meta">Transform <span className="normal-case text-meta">(generated from scratch, nothing physical to preserve)</span></div>
              <div className="flex flex-wrap gap-1.5">
                {Array.from(new Set([...TRANSFORMABLE, ...transform])).map((t) => (
                  <Chip key={t} active={transform.includes(t)} onClick={() => toggle(transform, setTransform, t)}>{t}</Chip>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {error && (
        <div className="flex items-center gap-2 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[12.5px] text-rose-200">
          <X className="size-4" /> {error}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex items-center gap-2 rounded border border-foreground/30 bg-foreground/10 px-4 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/15 disabled:opacity-60"
        >
          {submitting ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
          {submitting ? "Creating…" : "Create job & compose brief"}
        </button>
        <span className="text-[11.5px] text-meta">The Art Director assembles the Image Brief on create.</span>
      </div>
    </form>
  );
}
