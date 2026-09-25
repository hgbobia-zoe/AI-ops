"use client";

// Create-experiment form. Pick the test set (multi-select any existing Zoe images), define the providers
// (defaults OpenAI + Higgsfield; architecture supports any number), and set the controlled toggles. On submit
// the experiment is created as a DRAFT — inputs freeze when it is started from the detail view.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, X, Loader2, Sparkles, Plus, Trash2, FlaskConical } from "lucide-react";
import {
  ASSET_TYPES,
  ASSET_TYPE_LABEL,
  ASPECT_RATIOS,
  ASPECT_RATIO_LABEL,
  type AssetType,
  type AspectRatio,
  type CreativeImage,
} from "@/lib/creative/types";
import { BENCHMARK_PROVIDER_CATALOG, DEFAULT_TEMPLATE, blindLabelFor } from "@/lib/creative/experimentTypes";

interface ProviderRow {
  providerId: string;
  providerName: string;
  model: string;
  enabled: boolean;
}

const inputCls =
  "w-full rounded border border-border bg-card px-2.5 py-1.5 text-[12.5px] text-foreground outline-none placeholder:text-meta focus:border-foreground/30";

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.06em] text-meta">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-meta">{hint}</span>}
    </label>
  );
}

function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`flex items-start gap-2 rounded border p-2.5 text-left transition-colors ${checked ? "border-foreground/40 bg-foreground/[0.06]" : "border-border hover:bg-[var(--row-hover)]"}`}
    >
      <span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border ${checked ? "border-foreground bg-foreground text-background" : "border-border"}`}>
        {checked && <Check className="size-3" />}
      </span>
      <span>
        <span className="block text-[12.5px] font-medium text-foreground">{label}</span>
        {hint && <span className="block text-[11px] text-meta">{hint}</span>}
      </span>
    </button>
  );
}

export function NewExperimentForm({ selectableImages, useTemplate }: { selectableImages: CreativeImage[]; useTemplate: boolean }): React.JSX.Element {
  const router = useRouter();
  const t = DEFAULT_TEMPLATE;
  const [name, setName] = useState(useTemplate ? t.name : "");
  const [description, setDescription] = useState(useTemplate ? t.description : "");
  const [assetType, setAssetType] = useState<AssetType>(t.assetType);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>(t.aspectRatio);
  const [targetAudience, setTargetAudience] = useState("");
  const [objective, setObjective] = useState("");
  const [blinding, setBlinding] = useState(t.blinding);
  const [autoQa, setAutoQa] = useState(t.autoQa);
  const [humanEval, setHumanEval] = useState(t.humanEval);
  const [costTracking, setCostTracking] = useState(t.costTracking);

  const [providers, setProviders] = useState<ProviderRow[]>(
    BENCHMARK_PROVIDER_CATALOG.map((p) => ({ providerId: p.providerId, providerName: p.providerName, model: p.model, enabled: true })),
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enabledCount = providers.filter((p) => p.enabled && p.providerId.trim() && p.providerName.trim()).length;
  const matrix = useMemo(() => selected.size * enabledCount, [selected, enabledCount]);

  const toggleImage = (idOfImg: string): void =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(idOfImg)) n.delete(idOfImg);
      else n.add(idOfImg);
      return n;
    });

  const setProvider = (i: number, patch: Partial<ProviderRow>): void =>
    setProviders((prev) => prev.map((p, k) => (k === i ? { ...p, ...patch } : p)));
  const addProvider = (): void => setProviders((prev) => [...prev, { providerId: "", providerName: "", model: "", enabled: true }]);
  const removeProvider = (i: number): void => setProviders((prev) => prev.filter((_, k) => k !== i));

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!name.trim()) return setError("Give the experiment a name.");
    if (selected.size === 0) return setError("Select at least one source image for the test set.");
    if (enabledCount < 1) return setError("Add at least one enabled provider (with an id and name).");
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/creative/experiments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          description,
          phase: 1,
          assetType,
          aspectRatio,
          targetAudience,
          objective,
          blinding,
          autoQa,
          humanEval,
          costTracking,
          targetGenerationsPerProvider: 1,
          sourceImageIds: [...selected],
          providers: providers
            .filter((p) => p.providerId.trim() && p.providerName.trim())
            .map((p) => ({ providerId: p.providerId.trim(), providerName: p.providerName.trim(), model: p.model.trim() || null, enabled: p.enabled })),
        }),
      });
      const data = (await res.json()) as { ok?: boolean; experiment?: { id: string }; error?: string };
      if (!res.ok || !data.experiment) {
        setError(data.error || "Could not create the experiment.");
        setSubmitting(false);
        return;
      }
      router.push(`/creative/benchmarks/${data.experiment.id}`);
    } catch {
      setError("Could not create the experiment.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {useTemplate && (
        <div className="flex items-center gap-2 rounded border border-foreground/25 bg-foreground/[0.05] px-3 py-2 text-[12.5px] text-tertiary-text">
          <FlaskConical className="size-4 text-meta" /> Pre-filled from the <span className="font-medium text-foreground">Zoe Photography Benchmark V1</span> template. Select ~{t.suggestedSourceCount} source images to complete it.
        </div>
      )}

      {/* Definition */}
      <section className="rounded border border-border">
        <h2 className="border-b border-[var(--row-rule)] bg-panel px-3 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-tertiary-text">Experiment</h2>
        <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Zoe Photography Benchmark V1" /></Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Description" hint="What question this experiment is collecting data to answer"><textarea className={`${inputCls} min-h-[54px] resize-y`} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
          </div>
          <Field label="Asset type"><select className={inputCls} value={assetType} onChange={(e) => setAssetType(e.target.value as AssetType)}>{ASSET_TYPES.map((x) => <option key={x} value={x}>{ASSET_TYPE_LABEL[x]}</option>)}</select></Field>
          <Field label="Aspect ratio"><select className={inputCls} value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}>{ASPECT_RATIOS.map((x) => <option key={x} value={x}>{ASPECT_RATIO_LABEL[x]}</option>)}</select></Field>
          <Field label="Target audience"><input className={inputCls} value={targetAudience} onChange={(e) => setTargetAudience(e.target.value)} placeholder="Luxury wedding clients" /></Field>
          <Field label="Objective"><input className={inputCls} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="convey effortless luxury and scale" /></Field>
        </div>
        <div className="grid grid-cols-1 gap-2 border-t border-[var(--row-rule)] p-3 sm:grid-cols-4">
          <Toggle label="Blinded human eval" checked={blinding} onChange={setBlinding} hint="Show TEST A / TEST B, hide provider" />
          <Toggle label="Automated QA" checked={autoQa} onChange={setAutoQa} hint="Reuse the 8-axis scorecard" />
          <Toggle label="Human evaluation" checked={humanEval} onChange={setHumanEval} hint="Collect approvals" />
          <Toggle label="Cost tracking" checked={costTracking} onChange={setCostTracking} hint="From the callback meta" />
        </div>
        <div className="border-t border-[var(--row-rule)] px-3 py-2 text-[11px] text-meta">
          Phase 1 — first attempt: one generation per provider (measure first-pass quality). Later phases (regeneration, cost optimization) reuse this data model.
        </div>
      </section>

      {/* Providers */}
      <section className="rounded border border-border">
        <div className="flex items-center justify-between border-b border-[var(--row-rule)] bg-panel px-3 py-2">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-tertiary-text">Providers</h2>
          <button type="button" onClick={addProvider} className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)]"><Plus className="size-3.5" /> Add provider</button>
        </div>
        <div className="space-y-2 p-3">
          {providers.map((p, i) => (
            <div key={i} className="grid grid-cols-[auto_1fr_1fr_1fr_auto_auto] items-center gap-2">
              <span className="flex size-6 items-center justify-center rounded border border-border text-[11px] font-medium text-meta" title="Blind label">{blindLabelFor(i)}</span>
              <input className={inputCls} value={p.providerId} onChange={(e) => setProvider(i, { providerId: e.target.value })} placeholder="provider id (openai-image)" />
              <input className={inputCls} value={p.providerName} onChange={(e) => setProvider(i, { providerName: e.target.value })} placeholder="display name (OpenAI)" />
              <input className={inputCls} value={p.model} onChange={(e) => setProvider(i, { model: e.target.value })} placeholder="model (gpt-image-1)" />
              <button type="button" onClick={() => setProvider(i, { enabled: !p.enabled })} className={`rounded border px-2 py-1.5 text-[11px] font-medium transition-colors ${p.enabled ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" : "border-border text-meta"}`}>{p.enabled ? "Enabled" : "Off"}</button>
              <button type="button" onClick={() => removeProvider(i)} className="rounded border border-border p-1.5 text-meta transition-colors hover:bg-[var(--row-hover)] hover:text-rose-300"><Trash2 className="size-3.5" /></button>
            </div>
          ))}
          <p className="text-[11px] text-meta">During a benchmark, provider + model are prescriptive — the execution plane (n8n) must use exactly these, it does not choose. The Higgsfield integration itself is not built here.</p>
        </div>
      </section>

      {/* Test set */}
      <section className="rounded border border-border">
        <div className="flex items-center justify-between border-b border-[var(--row-rule)] bg-panel px-3 py-2">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-tertiary-text">Test set — {selected.size} source{selected.size === 1 ? "" : "s"} selected</h2>
          <span className="text-[11px] text-meta">{selected.size} × {enabledCount} provider{enabledCount === 1 ? "" : "s"} = <span className="font-medium text-tertiary-text">{matrix} generation{matrix === 1 ? "" : "s"}</span></span>
        </div>
        <div className="p-3">
          {selectableImages.length === 0 ? (
            <p className="text-[12px] text-meta">No images in the library yet. Upload photos in the Creative Engine (New Creative Job → Upload) to build a test set.</p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-6">
              {selectableImages.map((img) => {
                const on = selected.has(img.id);
                return (
                  <button type="button" key={img.id} onClick={() => toggleImage(img.id)} className={`group relative overflow-hidden rounded border ${on ? "border-foreground" : "border-border hover:border-foreground/40"}`} title={img.name ?? img.id}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={img.path} alt={img.name ?? "source"} className="h-20 w-full object-cover" />
                    {on && <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-foreground text-background"><Check className="size-3" /></span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {error && <div className="flex items-center gap-2 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[12.5px] text-rose-200"><X className="size-4" /> {error}</div>}

      <div className="flex items-center gap-2">
        <button type="submit" disabled={submitting} className="inline-flex items-center gap-2 rounded border border-foreground/30 bg-foreground/10 px-4 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/15 disabled:opacity-60">
          {submitting ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
          {submitting ? "Creating…" : "Create experiment"}
        </button>
        <span className="text-[11.5px] text-meta">Created as a draft. Inputs freeze when you start it.</span>
      </div>
    </form>
  );
}
