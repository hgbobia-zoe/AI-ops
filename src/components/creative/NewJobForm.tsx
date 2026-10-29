"use client";

// The New Creative Job form — a focused, four-step creation flow over the SHARED Nocturne system.
//
// Order mirrors how the decision actually gets made: pick the SOURCE first (it decides whether PRESERVE
// applies at all), then what you're making and where it lives, then the essential brief, then OPTIONAL
// creative direction. Every field is always mounted in a single state object, so moving between steps —
// or a failed submit — never drops entered work. A contextual summary rides alongside on desktop and
// stacks below on mobile.
//
// Honesty (platform law): this screen ONLY defines the job and composes the Image Brief. It does not
// generate or publish an image — that happens later, on the job detail. The copy and the summary say so.
// Every structured input is preserved; no advanced control was removed to shorten the form.

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Upload, ImageIcon, Sparkles, Check, X, Loader2, ArrowLeft, ArrowRight,
  ShieldCheck, Wand2, FileText, type LucideIcon,
} from "lucide-react";
import {
  ASSET_TYPES,
  ASSET_TYPE_LABEL,
  ASPECT_RATIOS,
  ASPECT_RATIO_LABEL,
  ASPECT_RATIO_SHORT,
  SOURCE_MODES,
  SOURCE_MODE_LABEL,
  SOURCE_MODE_HELP,
  PRESERVABLE,
  TRANSFORMABLE,
  aspectCss,
  isPortrait,
  isReferenceFirst,
  type AssetType,
  type AspectRatio,
  type SourceMode,
  type CreativeImage,
} from "@/lib/creative/types";
import {
  INITIAL_FIELDS,
  STEPS,
  stepIndex,
  validateNewJob,
  firstErrorStep,
  buildJobPayload,
  defaultsFor,
  summaryLines,
  filledBriefCount,
  type NewJobFields,
  type StepId,
  type FieldError,
} from "@/lib/creative/newJobForm";
import { Surface } from "@/components/ui/surface";
import { FocusFormLayout } from "@/components/ui/layouts";
import { StatusBanner } from "@/components/ui/states";
import { Button } from "@/components/ui/button";

const SOURCE_ICON: Record<SourceMode, LucideIcon> = { upload: Upload, existing: ImageIcon, scratch: Sparkles };

// Upload restrictions, surfaced to the user (kept in sync with /api/creative/upload).
const UPLOAD_HINT = "JPG, PNG, WebP, GIF, SVG or AVIF · up to 15 MB";

const inputCls =
  "w-full rounded-md border border-input bg-card px-3 py-2 text-[13px] text-foreground outline-none placeholder:text-meta focus-visible:border-ring";

// ── Small presentational helpers (form-local) ───────────────────────────────────────────────────────

function Field({
  label,
  htmlFor,
  required,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const errId = htmlFor ? `${htmlFor}-error` : undefined;
  return (
    <div className="block">
      <label htmlFor={htmlFor} className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-meta">
        {label}
        {required ? (
          <span className="text-status-blocked" aria-hidden>*</span>
        ) : (
          <span className="normal-case tracking-normal text-meta/70">optional</span>
        )}
      </label>
      {children}
      {hint && !error && <span className="mt-1 block text-[11px] text-meta">{hint}</span>}
      {error && (
        <span id={errId} role="alert" className="mt-1 flex items-center gap-1.5 text-[11.5px]">
          <X className="size-3.5 shrink-0 text-status-blocked" aria-hidden />
          <span className="text-status-label">{error}</span>
        </span>
      )}
    </div>
  );
}

function SectionHeading({ title, sub }: { title: string; sub?: string }): React.JSX.Element {
  return (
    <div className="mb-3">
      <h2 className="text-[15px] font-semibold tracking-tight text-foreground">{title}</h2>
      {sub && <p className="mt-0.5 text-[12px] text-meta">{sub}</p>}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[12px] transition-colors ${
        active
          ? "border-foreground/40 bg-foreground/10 text-foreground"
          : "border-border text-tertiary-text hover:bg-[var(--row-hover)]"
      }`}
    >
      {active && <Check className="size-3" aria-hidden />}
      {children}
    </button>
  );
}

// A visual aspect-ratio tile: the inner box carries the TRUE proportions (fixed height, CSS aspect-ratio
// → accurate width). Behaves as a radio with an accessible label (the full ratio description).
function AspectTile({
  ratio,
  active,
  onSelect,
}: {
  ratio: AspectRatio;
  active: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={ASPECT_RATIO_LABEL[ratio]}
      onClick={onSelect}
      className={`flex flex-col items-center gap-1.5 rounded-md border px-2 py-2.5 transition-colors ${
        active ? "border-foreground/50 bg-foreground/[0.06]" : "border-border hover:bg-[var(--row-hover)]"
      }`}
    >
      <span className="flex h-12 items-center justify-center" aria-hidden>
        <span
          className={`block rounded-[3px] border ${active ? "border-foreground/60 bg-foreground/20" : "border-tertiary-text/50 bg-foreground/10"}`}
          style={{ aspectRatio: aspectCss(ratio), height: isPortrait(ratio) ? 44 : undefined, width: isPortrait(ratio) ? undefined : 56 }}
        />
      </span>
      <span className={`text-[12px] font-medium tabular-nums ${active ? "text-foreground" : "text-tertiary-text"}`}>
        {ASPECT_RATIO_SHORT[ratio]}
      </span>
    </button>
  );
}

function imageProvenance(img: CreativeImage): string {
  const base = img.kind === "upload" ? "Uploaded photo" : "Existing Zoe image";
  return img.placeholder ? `${base} · placeholder (not a real photo)` : base;
}

// ── The form ─────────────────────────────────────────────────────────────────────────────────────

export function NewJobForm({ selectableImages }: { selectableImages: CreativeImage[] }): React.JSX.Element {
  const router = useRouter();
  const uid = useId();

  const [fields, setFields] = useState<NewJobFields>(INITIAL_FIELDS);
  const [step, setStep] = useState<StepId>("source");
  const [touchedPT, setTouchedPT] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState<CreativeImage[]>([]);
  const [customPreserve, setCustomPreserve] = useState("");
  const [customTransform, setCustomTransform] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldError[]>([]);

  const images = useMemo(() => [...uploaded, ...selectableImages], [uploaded, selectableImages]);
  const referenceFirst = isReferenceFirst(fields.sourceMode);
  const selectedImage = fields.sourceImageId ? images.find((i) => i.id === fields.sourceImageId) ?? null : null;
  const errorFor = (field: keyof NewJobFields): string | undefined => errors.find((e) => e.field === field)?.message;

  const patch = (p: Partial<NewJobFields>): void => setFields((f) => ({ ...f, ...p }));
  // Clear a field's validation error as soon as the user touches it.
  const clearError = (field: keyof NewJobFields): void => setErrors((e) => e.filter((x) => x.field !== field));

  function onSourceMode(v: SourceMode): void {
    clearError("sourceImageId");
    setFields((f) => {
      const next: NewJobFields = { ...f, sourceMode: v };
      if (v === "scratch") next.sourceImageId = null;
      if (!touchedPT) {
        const d = defaultsFor(v, f.assetType);
        next.preserve = d.preserve;
        next.transform = d.transform;
      }
      return next;
    });
  }

  function onAssetType(v: AssetType): void {
    setFields((f) => {
      const next: NewJobFields = { ...f, assetType: v };
      if (!touchedPT) {
        const d = defaultsFor(f.sourceMode, v);
        next.preserve = d.preserve;
        next.transform = d.transform;
      }
      return next;
    });
  }

  const toggle = (key: "preserve" | "transform", item: string): void => {
    setTouchedPT(true);
    setFields((f) => {
      const list = f[key];
      return { ...f, [key]: list.includes(item) ? list.filter((x) => x !== item) : [...list, item] };
    });
  };
  const addCustom = (key: "preserve" | "transform", raw: string, clear: () => void): void => {
    const v = raw.trim();
    if (!v) return;
    setTouchedPT(true);
    setFields((f) => (f[key].includes(v) ? f : { ...f, [key]: [...f[key], v] }));
    clear();
  };

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/creative/upload", { method: "POST", body: fd });
      const data = (await res.json()) as { ok?: boolean; image?: CreativeImage; error?: string };
      if (!res.ok || !data.image) {
        setUploadError(
          data.error === "too_large"
            ? "That file is over the 15 MB limit. Choose a smaller photo."
            : data.error === "unsupported_type"
              ? "That file type isn't supported. Use JPG, PNG, WebP, GIF, SVG or AVIF."
              : "Upload failed. Try again, or pick a different photo.",
        );
      } else {
        setUploaded((u) => [data.image!, ...u]);
        clearError("sourceImageId");
        patch({ sourceImageId: data.image.id });
      }
    } catch {
      setUploadError("Upload failed. Check your connection and try again.");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  function goTo(id: StepId): void {
    setStep(id);
  }
  function next(): void {
    const i = stepIndex(step);
    if (i < STEPS.length - 1) setStep(STEPS[i + 1].id);
  }
  function back(): void {
    const i = stepIndex(step);
    if (i > 0) setStep(STEPS[i - 1].id);
  }

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const found = validateNewJob(fields);
    if (found.length > 0) {
      setErrors(found);
      setSubmitError(null);
      const target = firstErrorStep(found);
      if (target) setStep(target);
      return;
    }
    setErrors([]);
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/creative/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildJobPayload(fields)),
      });
      const data = (await res.json()) as { ok?: boolean; job?: { id: string }; error?: string };
      if (!res.ok || !data.job) {
        setSubmitError(data.error ? `Could not create the job (${data.error}).` : "Could not create the job. Try again.");
        setSubmitting(false);
        return;
      }
      router.push(`/creative/${data.job.id}`);
    } catch {
      setSubmitError("Could not create the job. Check your connection and try again.");
      setSubmitting(false);
    }
  }

  const isLast = stepIndex(step) === STEPS.length - 1;
  const briefCount = filledBriefCount(fields);

  // ── Step rail (clickable; always navigable so entered work is reachable from anywhere) ──
  const rail = (
    <ol className="flex flex-wrap gap-1.5" aria-label="Creation steps">
      {STEPS.map((s, i) => {
        const active = s.id === step;
        const hasError = errors.some((e) => e.step === s.id);
        return (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => goTo(s.id)}
              aria-current={active ? "step" : undefined}
              className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-[12px] transition-colors ${
                active ? "border-foreground/40 bg-foreground/10 text-foreground" : "border-border text-tertiary-text hover:bg-[var(--row-hover)]"
              }`}
            >
              <span
                className={`flex size-5 shrink-0 items-center justify-center rounded-full border text-[10.5px] font-semibold tabular-nums ${
                  hasError
                    ? "border-status-blocked text-status-blocked"
                    : active
                      ? "border-foreground/50 text-foreground"
                      : "border-border text-meta"
                }`}
              >
                {hasError ? "!" : i + 1}
              </span>
              <span className="font-medium">{s.label}</span>
              {s.optional && <span className="text-[10.5px] text-meta">optional</span>}
            </button>
          </li>
        );
      })}
    </ol>
  );

  // ── Each step's body ──
  const sourceStep = (
    <Surface className="space-y-4">
      <SectionHeading title="Where do the pixels come from?" sub="Pick this first — it decides what the source constrains." />
      <div role="radiogroup" aria-label="Source" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {SOURCE_MODES.map((m) => {
          const Icon = SOURCE_ICON[m];
          const active = fields.sourceMode === m;
          return (
            <button
              type="button"
              key={m}
              role="radio"
              aria-checked={active}
              onClick={() => onSourceMode(m)}
              className={`flex flex-col gap-1 rounded-md border p-3 text-left transition-colors ${
                active ? "border-foreground/50 bg-foreground/[0.06]" : "border-border hover:bg-[var(--row-hover)]"
              }`}
            >
              <span className={`flex items-center gap-2 text-[13px] font-medium ${active ? "text-foreground" : "text-tertiary-text"}`}>
                <Icon className="size-4" aria-hidden /> {SOURCE_MODE_LABEL[m]}
              </span>
              <span className="text-[11.5px] text-meta">{SOURCE_MODE_HELP[m]}</span>
            </button>
          );
        })}
      </div>

      {fields.sourceMode === "upload" && (
        <div>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-input bg-card px-3 py-2 text-[13px] text-foreground transition-colors hover:bg-[var(--row-hover)]">
            {uploading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Upload className="size-4 text-tertiary-text" aria-hidden />}
            {uploading ? "Uploading…" : "Choose a photo"}
            <input type="file" accept="image/*" className="sr-only" onChange={onUpload} disabled={uploading} />
          </label>
          <span className="mt-1 block text-[11px] text-meta">{UPLOAD_HINT} · becomes the source of truth for PRESERVE.</span>
          {uploadError && (
            <div className="mt-2">
              <StatusBanner tone="critical" title="Upload failed">{uploadError}</StatusBanner>
            </div>
          )}
        </div>
      )}

      {referenceFirst && (
        <div>
          <span className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-meta">
            {fields.sourceMode === "existing" ? "Pick the source of truth" : "Selected source"}
            {errorFor("sourceImageId") && <span className="text-status-blocked" aria-hidden>*</span>}
          </span>
          {images.length > 0 ? (
            <div role="radiogroup" aria-label="Source image" className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {images.map((img) => {
                const active = fields.sourceImageId === img.id;
                return (
                  <button
                    type="button"
                    key={img.id}
                    role="radio"
                    aria-checked={active}
                    aria-label={`${img.name ?? "source"} — ${imageProvenance(img)}`}
                    onClick={() => {
                      clearError("sourceImageId");
                      patch({ sourceImageId: img.id });
                    }}
                    className={`group relative overflow-hidden rounded-md border ${active ? "border-foreground" : "border-border hover:border-foreground/40"}`}
                    title={`${img.name ?? img.id} — ${imageProvenance(img)}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={img.path} alt={img.name ?? "source"} className="h-16 w-full object-cover" />
                    {active && (
                      <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-foreground text-background">
                        <Check className="size-3" aria-hidden />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-[11.5px] text-meta">
              No images in the library yet. {fields.sourceMode === "upload" ? "Upload one above" : "Upload one or switch to “Generate from scratch”"} to continue.
            </p>
          )}
          {selectedImage && (
            <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-meta">
              <ShieldCheck className="size-3.5 text-status-syncing" aria-hidden />
              {imageProvenance(selectedImage)} — its PRESERVE items (below) stay faithful to this photo.
            </p>
          )}
          {errorFor("sourceImageId") && (
            <span role="alert" className="mt-1.5 flex items-center gap-1.5 text-[11.5px]">
              <X className="size-3.5 shrink-0 text-status-blocked" aria-hidden />
              <span className="text-status-label">{errorFor("sourceImageId")}</span>
            </span>
          )}
        </div>
      )}
      {!referenceFirst && (
        <p className="flex items-center gap-1.5 text-[11.5px] text-meta">
          <Sparkles className="size-3.5 text-status-syncing" aria-hidden />
          No source photo — the brief alone directs a fully generated image, so there is nothing physical to preserve.
        </p>
      )}
    </Surface>
  );

  const assetStep = (
    <Surface className="space-y-5">
      <SectionHeading title="What are you making, and where does it live?" />
      <div>
        <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.06em] text-meta">Asset type</span>
        <div role="radiogroup" aria-label="Asset type" className="flex flex-wrap gap-1.5">
          {ASSET_TYPES.map((t) => {
            const active = fields.assetType === t;
            return (
              <button
                type="button"
                key={t}
                role="radio"
                aria-checked={active}
                onClick={() => onAssetType(t)}
                className={`rounded-md border px-2.5 py-1.5 text-[12px] transition-colors ${
                  active ? "border-foreground/50 bg-foreground/10 text-foreground" : "border-border text-tertiary-text hover:bg-[var(--row-hover)]"
                }`}
              >
                {ASSET_TYPE_LABEL[t]}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.06em] text-meta">Aspect ratio</span>
        <div role="radiogroup" aria-label="Aspect ratio" className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {ASPECT_RATIOS.map((r) => (
            <AspectTile key={r} ratio={r} active={fields.aspectRatio === r} onSelect={() => patch({ aspectRatio: r })} />
          ))}
        </div>
        <span className="mt-1.5 block text-[11px] text-meta">{ASPECT_RATIO_LABEL[fields.aspectRatio]}</span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Page" htmlFor={`${uid}-page`} hint="Where it will live on the site or in a campaign">
          <input id={`${uid}-page`} className={inputCls} value={fields.page} onChange={(e) => patch({ page: e.target.value })} placeholder="Home" />
        </Field>
        <Field label="Section" htmlFor={`${uid}-section`}>
          <input id={`${uid}-section`} className={inputCls} value={fields.section} onChange={(e) => patch({ section: e.target.value })} placeholder="Above the fold" />
        </Field>
      </div>
    </Surface>
  );

  const briefStep = (
    <Surface className="space-y-5">
      <SectionHeading title="The brief" sub="A title is all that's required. Fill the rest to sharpen the Art Director's read." />
      <Field label="Title" htmlFor={`${uid}-title`} required error={errorFor("title")}>
        <input
          id={`${uid}-title`}
          className={inputCls}
          value={fields.title}
          onChange={(e) => {
            clearError("title");
            patch({ title: e.target.value });
          }}
          aria-invalid={errorFor("title") ? true : undefined}
          aria-describedby={errorFor("title") ? `${uid}-title-error` : undefined}
          placeholder="Homepage hero — spring tented reception"
        />
      </Field>

      <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <legend className="mb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-tertiary-text">Product</legend>
        <Field label="Product" htmlFor={`${uid}-product`}>
          <input id={`${uid}-product`} className={inputCls} value={fields.product} onChange={(e) => patch({ product: e.target.value })} placeholder="Sailcloth tent" />
        </Field>
        <Field label="Product category" htmlFor={`${uid}-cat`}>
          <input id={`${uid}-cat`} className={inputCls} value={fields.productCategory} onChange={(e) => patch({ productCategory: e.target.value })} placeholder="Tents" />
        </Field>
      </fieldset>

      <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <legend className="mb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-tertiary-text">Audience &amp; campaign</legend>
        <Field label="Target audience" htmlFor={`${uid}-aud`}>
          <input id={`${uid}-aud`} className={inputCls} value={fields.targetAudience} onChange={(e) => patch({ targetAudience: e.target.value })} placeholder="Luxury wedding clients" />
        </Field>
        <Field label="Campaign" htmlFor={`${uid}-camp`}>
          <input id={`${uid}-camp`} className={inputCls} value={fields.campaign} onChange={(e) => patch({ campaign: e.target.value })} placeholder="Spring 2026" />
        </Field>
      </fieldset>

      <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <legend className="mb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-tertiary-text">Location &amp; season</legend>
        <Field label="Location context" htmlFor={`${uid}-loc`}>
          <input id={`${uid}-loc`} className={inputCls} value={fields.locationContext} onChange={(e) => patch({ locationContext: e.target.value })} placeholder="Manicured estate lawn, DMV" />
        </Field>
        <Field label="Season" htmlFor={`${uid}-season`}>
          <input id={`${uid}-season`} className={inputCls} value={fields.season} onChange={(e) => patch({ season: e.target.value })} placeholder="Late spring, golden hour" />
        </Field>
      </fieldset>

      <Field label="Objective" htmlFor={`${uid}-obj`} hint="What the image should accomplish">
        <input id={`${uid}-obj`} className={inputCls} value={fields.objective} onChange={(e) => patch({ objective: e.target.value })} placeholder="convey effortless luxury and scale" />
      </Field>
    </Surface>
  );

  const directionStep = (
    <Surface className="space-y-5">
      <SectionHeading title="Creative direction" sub="Optional. Sensible defaults are already applied from your source and asset type — adjust only what you want to steer." />

      <Field label="Visual direction" htmlFor={`${uid}-vis`} hint="A short note for the Art Director — mood, moment, light.">
        <textarea
          id={`${uid}-vis`}
          className={`${inputCls} min-h-[72px] resize-y`}
          value={fields.visualDirection}
          onChange={(e) => patch({ visualDirection: e.target.value })}
          placeholder="Warm, unhurried, guests mid-conversation, tent glowing at dusk."
        />
      </Field>

      {referenceFirst ? (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div>
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-meta">
              <ShieldCheck className="size-3.5 text-status-syncing" aria-hidden /> Preserve
              <span className="normal-case tracking-normal text-meta">— the source is the truth</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {Array.from(new Set([...PRESERVABLE, ...fields.preserve])).map((p) => (
                <Chip key={p} active={fields.preserve.includes(p)} onClick={() => toggle("preserve", p)}>{p}</Chip>
              ))}
            </div>
            <input
              className={`${inputCls} mt-2`}
              value={customPreserve}
              onChange={(e) => setCustomPreserve(e.target.value)}
              placeholder="Add a preserve rule"
              aria-label="Add a preserve rule"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCustom("preserve", customPreserve, () => setCustomPreserve(""));
                }
              }}
            />
          </div>
          <div>
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-meta">
              <Wand2 className="size-3.5 text-status-syncing" aria-hidden /> Transform
              <span className="normal-case tracking-normal text-meta">— AI may change</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {Array.from(new Set([...TRANSFORMABLE, ...fields.transform])).map((t) => (
                <Chip key={t} active={fields.transform.includes(t)} onClick={() => toggle("transform", t)}>{t}</Chip>
              ))}
            </div>
            <input
              className={`${inputCls} mt-2`}
              value={customTransform}
              onChange={(e) => setCustomTransform(e.target.value)}
              placeholder="Add a transform"
              aria-label="Add a transform"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCustom("transform", customTransform, () => setCustomTransform(""));
                }
              }}
            />
          </div>
        </div>
      ) : (
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-meta">
            <Wand2 className="size-3.5 text-status-syncing" aria-hidden /> Transform
            <span className="normal-case tracking-normal text-meta">— generated from scratch, nothing physical to preserve</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {Array.from(new Set([...TRANSFORMABLE, ...fields.transform])).map((t) => (
              <Chip key={t} active={fields.transform.includes(t)} onClick={() => toggle("transform", t)}>{t}</Chip>
            ))}
          </div>
        </div>
      )}
    </Surface>
  );

  const stepBody =
    step === "source" ? sourceStep : step === "asset" ? assetStep : step === "brief" ? briefStep : directionStep;

  // ── Contextual summary / preview (desktop rail · mobile stacked below) ──
  const summary = (
    <>
      <Surface className="space-y-3">
        <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-tertiary-text">Summary</div>

        {/* Output preview: true-proportion frame + asset/ratio */}
        <div className="flex items-center gap-3">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md border border-border bg-row" aria-hidden>
            {referenceFirst && selectedImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={selectedImage.path} alt="" className="max-h-12 max-w-12 rounded-sm object-cover" style={{ aspectRatio: aspectCss(fields.aspectRatio) }} />
            ) : (
              <span
                className="block rounded-sm border border-tertiary-text/40 bg-foreground/10"
                style={{ aspectRatio: aspectCss(fields.aspectRatio), height: isPortrait(fields.aspectRatio) ? 40 : undefined, width: isPortrait(fields.aspectRatio) ? undefined : 44 }}
              />
            )}
          </span>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-foreground">{fields.title.trim() || "Untitled asset"}</div>
            <div className="text-[11.5px] text-meta">
              {ASSET_TYPE_LABEL[fields.assetType]} · {ASPECT_RATIO_SHORT[fields.aspectRatio]}
            </div>
          </div>
        </div>

        <dl className="space-y-1 border-t border-rule pt-2 text-[12px]">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-meta">Source</dt>
            <dd className="truncate text-tertiary-text">{SOURCE_MODE_LABEL[fields.sourceMode]}</dd>
          </div>
          {referenceFirst && (
            <div className="flex items-center justify-between gap-2">
              <dt className="text-meta">Source photo</dt>
              <dd className="truncate text-tertiary-text">{selectedImage ? imageProvenance(selectedImage) : "not chosen yet"}</dd>
            </div>
          )}
          {(fields.page.trim() || fields.section.trim()) && (
            <div className="flex items-center justify-between gap-2">
              <dt className="text-meta">Lives on</dt>
              <dd className="truncate text-tertiary-text">{[fields.page, fields.section].filter((v) => v.trim()).join(" · ")}</dd>
            </div>
          )}
          {summaryLines(fields)
            .filter((l) => l.value !== "—")
            .map((l) => (
              <div key={l.label} className="flex items-center justify-between gap-2">
                <dt className="text-meta">{l.label}</dt>
                <dd className="truncate text-tertiary-text">{l.value}</dd>
              </div>
            ))}
          <div className="flex items-center justify-between gap-2 border-t border-rule pt-1.5">
            <dt className="text-meta">Brief detail</dt>
            <dd className="tabular-nums text-tertiary-text">{briefCount.filled} of {briefCount.total} filled</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-meta">Preserve · transform</dt>
            <dd className="tabular-nums text-tertiary-text">{fields.preserve.length} · {fields.transform.length}</dd>
          </div>
        </dl>
      </Surface>

      <Surface className="space-y-1.5">
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
          <FileText className="size-3.5 text-status-syncing" aria-hidden /> What happens when you create it
        </div>
        <p className="text-[11.5px] text-meta">
          This saves the job as a <span className="text-tertiary-text">draft</span> and composes its Image Brief (the Art
          Director&apos;s structured read of your inputs). <span className="text-foreground">No image is generated or published yet</span> —
          you review the brief and run generation afterward, on the job page.
        </p>
      </Surface>
    </>
  );

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {rail}

      <FocusFormLayout form={stepBody} summary={summary} />

      {submitError && (
        <StatusBanner tone="critical" title="Could not create the job">{submitError}</StatusBanner>
      )}
      {errors.length > 0 && !submitError && (
        <StatusBanner tone="attention" title="A couple of things need attention before you can create the job">
          <ul className="list-disc space-y-0.5 pl-4">
            {errors.map((e) => (
              <li key={e.field}>{e.message}</li>
            ))}
          </ul>
        </StatusBanner>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {stepIndex(step) > 0 && (
            <Button type="button" variant="outline" onClick={back}>
              <ArrowLeft className="size-4" aria-hidden /> Back
            </Button>
          )}
          <Link href="/creative" className="text-[12.5px] text-meta underline-offset-2 hover:text-foreground hover:underline">
            Cancel
          </Link>
        </div>
        <div className="flex items-center gap-2">
          {!isLast ? (
            <Button type="button" variant="outline" onClick={next}>
              Continue <ArrowRight className="size-4" aria-hidden />
            </Button>
          ) : null}
          <Button type="submit" disabled={submitting}>
            {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}
            {submitting ? "Creating…" : "Create job & compose brief"}
          </Button>
        </div>
      </div>
    </form>
  );
}
