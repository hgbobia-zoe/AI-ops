"use client";

// Inventory Import — a focused four-step workspace that bulk-copies a PARTNER's Goodshuffle storefront
// catalog into Zoe's own inventory for sub-rental. This is an IMPORT tool (not a general inventory
// manager): it reads a partner's public catalog, previews exactly what would be created, and generates
// the importer the operator runs from their own logged-in Goodshuffle tab. Goodshuffle has no public
// write API and Cloudflare blocks server calls, so the actual write never happens on our server.
//
// Ordered steps (never skipped): 1 Partner · 2 Configure · 3 Preview · 4 Write to Goodshuffle.
//   1) PARTNER    — pick a saved partner, or add one by its storefront link (resolve token → map groups).
//   2) CONFIGURE  — source identity, which groups → which Zoe categories, tags, and the fixed import policy.
//   3) PREVIEW    — resolve the plan server-side (/api/inventory/plan): counts, sample items, duplicates,
//                   explicit effects, warnings. NO writes happen here. Always visible, with an explanatory
//                   state before it has been run.
//   4) WRITE      — generate the verified importer bookmarklet (the current supported execution path), run
//                   from the logged-in Goodshuffle tab. Fails closed on any unresolved category.
//
// HONEST THROUGHOUT: nothing is written from this screen. Zoe cannot observe the external run, so no
// in-app progress/audit is fabricated — the importer itself dry-runs, confirms, paces under the rate
// limit, re-checks Zoe's live catalog (so re-running never duplicates) and logs progress to the console.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Boxes, Copy, Check, Loader2, AlertTriangle, Info, Image as ImageIcon, ImageOff,
  PackagePlus, Plus, X, RefreshCw, Tag as TagIcon, Link2, ChevronRight, Lock,
  DollarSign, Hash, Globe, CopyX, Store, ExternalLink, Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Surface } from "@/components/ui/surface";
import { PageHeader } from "@/components/ui/page-header";
import { BladeMain, FocusFormLayout } from "@/components/ui/layouts";
import { Metric, MetricGrid } from "@/components/ui/metric";
import { StatusBadge } from "@/components/ui/status";
import { EmptyState, ErrorState, StatusBanner } from "@/components/ui/states";
import { buildImporterBookmarklet, buildBackfillBookmarklet } from "@/lib/inventory/bookmarklets";
import type { InventoryPartner, PartnerMapping, ZoeCategory } from "@/lib/inventory/partners";
import type { PlanResponse } from "@/lib/inventory/service";
import { summarizePlan, executionState, deriveSteps, type StepInfo } from "@/lib/inventory/viewModel";

const DEFAULT_TAGS = ["Subrental"];

interface PartnersConfig {
  partners: InventoryPartner[];
  zoeCategories: ZoeCategory[];
}

interface DiscoveredGroup {
  slug: string;
  name: string;
  count: number;
}

// ── small local helpers ─────────────────────────────────────────────────────────────────────────────

function CopyBox({ label, value, hint }: { label: string; value: string; hint?: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      },
      () => {},
    );
  }, [value]);
  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center justify-between border-b border-rule px-3 py-2">
        <span className="text-[12px] font-medium text-foreground">{label}</span>
        <Button size="xs" variant="outline" onClick={copy}>
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <textarea
        readOnly
        value={value}
        aria-label={label}
        onFocus={(e) => e.currentTarget.select()}
        className="block h-20 w-full resize-none bg-transparent px-3 py-2 font-mono text-[11px] leading-relaxed text-tertiary-text outline-none"
      />
      {hint && <p className="border-t border-rule px-3 py-1.5 text-[11px] text-meta">{hint}</p>}
    </div>
  );
}

// A section header with the ordered step number + title + an inline status. The number keeps the steps
// explicitly 1..4 (no skipped numbering); the StatusBadge reports the step's real state.
function StepHeader({
  index,
  title,
  state,
  statusLabel,
}: {
  index: number;
  title: string;
  state: StepInfo["state"];
  statusLabel?: string;
}): React.JSX.Element {
  const tone = state === "done" ? "positive" : state === "locked" ? "neutral" : "info";
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="flex items-center gap-2.5 text-[14px] font-semibold tracking-tight text-foreground">
        <span
          className={`inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-[12px] tabular-nums ${
            state === "locked" ? "border-border text-meta" : "border-foreground/30 text-foreground"
          }`}
          aria-hidden
        >
          {state === "locked" ? <Lock className="size-3" /> : index}
        </span>
        {title}
      </h2>
      {statusLabel && <StatusBadge tone={tone} size="sm" animated>{statusLabel}</StatusBadge>}
    </div>
  );
}

// A single preview item's thumbnail — shows the real partner photo when one is available, and a clear
// "no photo" placeholder otherwise (so "photos" is an honest, visible effect, never implied).
function ItemThumb({ url, alt }: { url: string | undefined; alt: string }): React.JSX.Element {
  const [broken, setBroken] = useState(false);
  if (!url || broken) {
    return (
      <span className="flex size-9 shrink-0 items-center justify-center rounded border border-border bg-row text-meta" title="No photo" aria-label="No photo">
        <ImageOff className="size-4" aria-hidden />
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- external partner storefront URLs, not app assets
    <img
      src={url}
      alt={alt}
      loading="lazy"
      onError={() => setBroken(true)}
      className="size-9 shrink-0 rounded border border-border object-cover"
    />
  );
}

export function InventoryAutomation(): React.JSX.Element {
  const [config, setConfig] = useState<PartnersConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [selectedPartnerId, setSelectedPartnerId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tags, setTags] = useState<string[]>(DEFAULT_TAGS);
  const [tagInput, setTagInput] = useState("");

  const [loading, setLoading] = useState(false);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Apply a partner selection: remember it, select all its groups, and clear any stale plan. Called from
  // the partner buttons and after a config (re)load, so selection state is set from an event — not an effect.
  const applySelection = (partners: InventoryPartner[], id: string | null) => {
    const p = partners.find((x) => x.id === id) ?? null;
    setSelectedPartnerId(p?.id ?? null);
    setSelected(new Set(p ? p.mappings.map((m) => m.key) : []));
    setPlan(null);
    setError(null);
  };

  const loadConfig = useCallback(async (selectId?: string) => {
    try {
      const res = await fetch("/api/inventory/partners");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as PartnersConfig;
      setConfig(data);
      setConfigError(null);
      const pick = selectId && data.partners.some((p) => p.id === selectId) ? selectId : data.partners[0]?.id ?? null;
      applySelection(data.partners, pick);
    } catch (e) {
      setConfigError(e instanceof Error ? e.message : "Could not load partners.");
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await loadConfig();
    })();
  }, [loadConfig]);

  const partner = useMemo(
    () => config?.partners.find((p) => p.id === selectedPartnerId) ?? null,
    [config, selectedPartnerId],
  );

  const toggleGroup = (key: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const addTag = () => {
    const t = tagInput.trim();
    if (!t) return;
    if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) setTags([...tags, t]);
    setTagInput("");
  };
  const removeTag = (t: string) => setTags(tags.filter((x) => x !== t));

  const preview = useCallback(async () => {
    if (!partner) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/inventory/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          partnerId: partner.id,
          groups: Array.from(selected),
          addTags: tags,
          policy: { trackQuantity: false },
        }),
      });
      const data = (await res.json()) as PlanResponse;
      if (!res.ok || !data.ok) {
        setError(data.error || `Plan failed (HTTP ${res.status})`);
        setPlan(null);
      } else {
        setPlan(data);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setPlan(null);
    } finally {
      setLoading(false);
    }
  }, [partner, selected, tags]);

  const toCreate = useMemo(() => plan?.plan.toCreate ?? [], [plan]);
  const groupLabelByTarget = useMemo(() => {
    const m: Record<string, string> = {};
    for (const g of plan?.groups ?? []) m[g.targetCategory] = g.label;
    return m;
  }, [plan]);
  const groupLabel = (zoeGroup: string) => groupLabelByTarget[zoeGroup] ?? zoeGroup;

  // Derived, honest view-model (pure; unit-tested in viewModel.test.ts).
  const summary = useMemo(() => (plan ? summarizePlan(plan) : null), [plan]);
  const exec = useMemo(() => executionState(plan), [plan]);
  const hasPartner = !!partner && !adding;
  const steps = useMemo(
    () => deriveSteps({ hasPartner, selectedGroups: selected.size, hasPlan: !!plan, exec }),
    [hasPartner, selected.size, plan, exec],
  );
  const stepByKey = useMemo(() => Object.fromEntries(steps.map((s) => [s.key, s])) as Record<StepInfo["key"], StepInfo>, [steps]);

  const importerBookmarklet = useMemo(() => {
    if (!plan || exec.status !== "ready") return null;
    return buildImporterBookmarklet({ plan: toCreate, categories: plan.categories, zoeToken: plan.zoeToken, internalNotes: plan.internalNotes });
  }, [plan, exec.status, toCreate]);

  // Backfill: all source items that carry at least one photo (the bookmarklet matches each to Zoe's live
  // catalog and only attaches photos to ones that exist there and have none).
  const backfillItems = useMemo(() => (plan?.backfillItems ?? []).filter((b) => b.imageUrls.length > 0), [plan]);
  const backfillBookmarklet = useMemo(() => {
    if (!plan || backfillItems.length === 0) return null;
    return buildBackfillBookmarklet({ items: backfillItems, internalNotes: plan.internalNotes });
  }, [plan, backfillItems]);

  const form = (
    <>
      {configError && (
        <ErrorState tone="critical" title="Couldn't load partners" body={configError} action={<Button size="sm" variant="outline" onClick={() => void loadConfig()}><RefreshCw className="size-3.5" /> Retry</Button>} />
      )}

      {/* 1) PARTNER */}
      <Surface pad="md" aria-labelledby="step-partner">
        <StepHeader
          index={1}
          title="Partner"
          state={stepByKey.partner.state}
          statusLabel={adding ? "Adding a partner" : partner ? `${partner.name} selected` : "Choose a partner"}
        />
        {!config ? (
          <div className="flex items-center gap-2 text-[12.5px] text-meta"><Loader2 className="size-3.5 animate-spin" /> Loading partners…</div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {config.partners.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  applySelection(config.partners, p.id);
                  setAdding(false);
                }}
                className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 text-[13px] transition-colors ${
                  !adding && p.id === selectedPartnerId
                    ? "border-foreground/40 bg-row-hover text-foreground"
                    : "border-border text-tertiary-text hover:bg-row-hover"
                }`}
              >
                <PackagePlus className="size-4 text-meta" /> {p.name}
                <span className="text-[11px] text-meta">{p.mappings.length} group{p.mappings.length === 1 ? "" : "s"}</span>
              </button>
            ))}
            {config.partners.length === 0 && <span className="text-[12.5px] text-meta">No partners configured yet. Add one by its storefront link.</span>}
            <button
              onClick={() => setAdding(true)}
              className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-[13px] transition-colors ${
                adding ? "border-foreground/40 bg-row-hover text-foreground" : "border-dashed border-border text-tertiary-text hover:bg-row-hover"
              }`}
            >
              <Plus className="size-4" /> Add partner
            </button>
          </div>
        )}

        {config && adding && (
          <AddPartner
            zoeCategories={config.zoeCategories}
            existingIds={config.partners.map((p) => p.id)}
            onCancel={() => setAdding(false)}
            onSaved={(newId) => {
              setAdding(false);
              void loadConfig(newId);
            }}
          />
        )}
      </Surface>

      {/* 2) CONFIGURE */}
      <Surface pad="md" aria-labelledby="step-configure">
        <StepHeader
          index={2}
          title="Configure the job"
          state={stepByKey.configure.state}
          statusLabel={stepByKey.configure.state === "locked" ? "Locked" : `${selected.size} group${selected.size === 1 ? "" : "s"} selected`}
        />
        {!partner || adding ? (
          <p className="text-[12.5px] text-meta">{stepByKey.configure.detail ?? "Select a partner to configure the import."}</p>
        ) : (
          <div className="space-y-5">
            {/* Source identity */}
            <div className="grid gap-3 sm:grid-cols-3">
              <SourceFact icon={<Store className="size-3.5" />} label="Partner" value={partner.name} />
              <SourceFact
                icon={<Link2 className="size-3.5" />}
                label="Storefront"
                value={
                  partner.storefrontUrl ? (
                    <a href={partner.storefrontUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-tertiary-text underline-offset-2 hover:text-foreground hover:underline">
                      {prettyHost(partner.storefrontUrl)} <ExternalLink className="size-3" aria-hidden />
                    </a>
                  ) : (
                    <span className="text-meta">not recorded</span>
                  )
                }
              />
              <SourceFact icon={<Hash className="size-3.5" />} label="Vendor token" value={<code className="text-[11.5px] text-tertiary-text">{partner.vendorToken}</code>} />
            </div>

            {/* Groups → categories */}
            <div>
              <label className="mb-1.5 block text-[11px] uppercase tracking-[0.08em] text-meta">Groups to import &rarr; Zoe category</label>
              <div className="flex flex-col divide-y divide-[var(--row-rule)] overflow-hidden rounded-md border border-border">
                {partner.mappings.map((m) => (
                  <label key={m.key} className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-[13px] text-foreground hover:bg-row-hover">
                    <Checkbox checked={selected.has(m.key)} onCheckedChange={() => toggleGroup(m.key)} />
                    <span className="min-w-0 flex-1">{m.label}</span>
                    <span className="inline-flex items-center gap-1 text-[11.5px] text-meta">
                      <ChevronRight className="size-3" aria-hidden /> {m.targetCategory}
                    </span>
                  </label>
                ))}
                {partner.mappings.length === 0 && <p className="px-3 py-2 text-[12px] text-meta">This partner has no group mappings.</p>}
              </div>
            </div>

            {/* Tags */}
            <div>
              <label className="mb-1.5 block text-[11px] uppercase tracking-[0.08em] text-meta">Tags applied to every copied item</label>
              <div className="flex flex-wrap items-center gap-1.5">
                {tags.map((t) => (
                  <span key={t} className="inline-flex items-center gap-1 rounded-md border border-border bg-row-hover px-2 py-1 text-[12px] text-foreground">
                    <TagIcon className="size-3 text-meta" /> {t}
                    <button onClick={() => removeTag(t)} aria-label={`Remove ${t}`} className="text-meta hover:text-foreground">
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
                <span className="inline-flex items-center gap-1">
                  <input
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addTag();
                      }
                    }}
                    placeholder="Add tag"
                    aria-label="Add tag"
                    className="w-24 rounded-md border border-border bg-transparent px-2 py-1 text-[12px] text-foreground outline-none placeholder:text-meta focus:border-foreground/30"
                  />
                  <Button size="xs" variant="ghost" onClick={addTag} aria-label="Add tag"><Plus className="size-3" /></Button>
                </span>
              </div>
            </div>

            {/* Import policy — fixed in v1; shown as explicit effects, not restyled defaults */}
            <div>
              <label className="mb-1.5 block text-[11px] uppercase tracking-[0.08em] text-meta">Import policy (fixed)</label>
              <PolicyEffects />
              <p className="mt-2 text-[11px] text-meta">Copies title, description, tags and photos only. These defaults are not editable in this version.</p>
            </div>

            <div className="flex flex-wrap items-center gap-3 border-t border-rule pt-4">
              <Button onClick={preview} disabled={loading || selected.size === 0}>
                {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                {loading ? "Resolving plan…" : plan ? "Re-run preview" : "Preview plan"}
              </Button>
              {selected.size === 0 && <span className="text-[12px] text-meta">Select at least one group.</span>}
              <span className="ml-auto inline-flex items-center gap-1.5 text-[11.5px] text-meta"><Info className="size-3.5" aria-hidden /> Preview reads only — nothing is written.</span>
            </div>
          </div>
        )}
      </Surface>

      {error && (
        <ErrorState tone="critical" title="Preview failed" body={error} />
      )}

      {/* 3) PREVIEW — always shown, with an explanatory state before it has content */}
      <Surface pad="md" aria-labelledby="step-preview">
        <StepHeader
          index={3}
          title="Preview the plan"
          state={stepByKey.preview.state}
          statusLabel={plan ? `${toCreate.length} to create` : stepByKey.preview.state === "locked" ? "Locked" : "Not run yet"}
        />
        {!plan || adding ? (
          <EmptyState
            icon={<RefreshCw className="size-5" />}
            title={plan ? "Preview hidden while adding a partner" : "No preview yet"}
            body={stepByKey.preview.detail ?? "Configure the job above, then run Preview to see exactly what would be created — with counts, sample items, duplicates and effects. No writes happen here."}
          />
        ) : summary ? (
          <div className="space-y-4">
            {/* Counts */}
            <MetricGrid>
              <Metric label="To create" value={summary.toCreate} tone={summary.toCreate > 0 ? "positive" : "neutral"} sub={`across ${summary.groupsCount} group${summary.groupsCount === 1 ? "" : "s"}`} />
              <Metric label="Skipped" value={summary.skippedTotal} sub={`${summary.skippedDuplicates} duplicate${summary.skippedDuplicates === 1 ? "" : "s"}${summary.skippedNoTitle ? ` · ${summary.skippedNoTitle} no title` : ""}`} />
              <Metric label="Photos" value={summary.totalPhotos} tone={summary.itemsMissingPhotos > 0 ? "attention" : undefined} sub={summary.itemsMissingPhotos > 0 ? `${summary.itemsMissingPhotos} item${summary.itemsMissingPhotos === 1 ? "" : "s"} with none` : `on ${summary.itemsWithPhotos} item${summary.itemsWithPhotos === 1 ? "" : "s"}`} />
              <Metric label="Already in Zoe" value={summary.alreadyInZoe} tone={summary.partialRead ? "attention" : undefined} sub={summary.partialRead ? "partial — a catalog read failed" : "duplicates skipped"} />
            </MetricGrid>

            {/* Effects — what this plan WILL do, explicit */}
            <div>
              <div className="mb-1.5 text-[11px] uppercase tracking-[0.08em] text-meta">What this import will do</div>
              <PolicyEffects />
            </div>

            {/* Per-group breakdown */}
            <div>
              <div className="mb-1.5 text-[11px] uppercase tracking-[0.08em] text-meta">Per group</div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {plan.groups.map((g) => (
                  <div key={g.key} className="surface border border-border p-2.5">
                    <div className="truncate text-[11px] uppercase tracking-[0.06em] text-meta" title={g.label}>{g.label}</div>
                    <div className="mt-0.5 text-[16px] font-semibold tabular-nums text-foreground">{g.sourceCount}</div>
                    <div className="text-[11px] text-meta">source · {g.alreadyInZoeCount} in Zoe</div>
                    {!g.categoryResolved && <div className="mt-1"><StatusBadge tone="critical" size="sm">No category id</StatusBadge></div>}
                    {(!g.sourceOk || !g.zoeOk) && <div className="mt-1"><StatusBadge tone="attention" size="sm">Partial read</StatusBadge></div>}
                  </div>
                ))}
              </div>
            </div>

            {/* Warnings */}
            {(plan.warnings.length > 0 || plan.plan.warnings.length > 0) && (
              <StatusBanner tone="attention" title={`${summary.warningsCount} warning${summary.warningsCount === 1 ? "" : "s"}`}>
                <ul className="list-disc space-y-0.5 pl-5">
                  {plan.warnings.map((w, i) => <li key={`s${i}`}>{w}</li>)}
                  {plan.plan.warnings.map((w, i) => <li key={`i${i}`}>{w}</li>)}
                </ul>
              </StatusBanner>
            )}

            {/* Items to create */}
            {toCreate.length === 0 ? (
              <div className="rounded-md border border-border px-3 py-3 text-[12.5px] text-meta">
                Nothing to create. Every source item already exists in Zoe&apos;s catalog (or no groups returned items).
              </div>
            ) : (
              <div>
                <div className="mb-1.5 text-[11px] uppercase tracking-[0.08em] text-meta">Items to create ({toCreate.length})</div>
                <div className="overflow-x-auto rounded-md border border-border">
                  <table className="w-full min-w-[560px] text-[12.5px]">
                    <thead>
                      <tr className="border-b border-rule text-left text-[10.5px] uppercase tracking-[0.06em] text-meta">
                        <th className="px-3 py-2 font-medium">Item</th>
                        <th className="px-3 py-2 font-medium">Target category</th>
                        <th className="px-3 py-2 font-medium">Photos</th>
                        <th className="px-3 py-2 font-medium">Tags</th>
                      </tr>
                    </thead>
                    <tbody>
                      {toCreate.map((it) => (
                        <tr key={it.sourceId} className="border-b border-rule/60 align-top last:border-0 hover:bg-row-hover">
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2.5">
                              <ItemThumb url={it.imageUrls[0]} alt={it.title} />
                              <span className="min-w-0 text-foreground">{it.title}</span>
                            </div>
                          </td>
                          <td className="px-3 py-2 text-tertiary-text">{groupLabel(it.zoeGroup)}</td>
                          <td className="px-3 py-2 text-tertiary-text">
                            {it.imageUrls.length > 0 ? (
                              <span className="inline-flex items-center gap-1"><ImageIcon className="size-3 text-meta" />{it.imageUrls.length}</span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-attention"><ImageOff className="size-3" />none</span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <span className="flex flex-wrap gap-1">
                              {it.tags.map((t) => (
                                <span key={t} className="rounded border border-border px-1.5 py-0.5 text-[11px] text-tertiary-text">{t}</span>
                              ))}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Skipped */}
            {plan.plan.skipped.length > 0 && (
              <details className="rounded-md border border-border">
                <summary className="cursor-pointer px-3 py-2 text-[12.5px] text-tertiary-text">
                  {plan.plan.skipped.length} skipped (duplicates / no title)
                </summary>
                <ul className="border-t border-rule px-3 py-2 text-[12px] text-meta">
                  {plan.plan.skipped.map((s, i) => (
                    <li key={i} className="flex justify-between gap-3 border-t border-rule py-1 first:border-t-0">
                      <span className="truncate text-tertiary-text">{s.title}</span>
                      <span className="shrink-0">{s.reason}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        ) : null}
      </Surface>

      {/* 4) WRITE */}
      <Surface pad="md" aria-labelledby="step-write">
        <StepHeader
          index={4}
          title="Write to Goodshuffle"
          state={stepByKey.execute.state}
          statusLabel={exec.status === "ready" ? `${exec.count} to write` : exec.status === "blocked" ? "Blocked" : exec.status === "nothing" ? "Nothing to write" : "Locked"}
        />

        <StatusBanner
          tone="info"
          edge
          title="This is an external write — done by you, in your browser"
          icon={<ExternalLink className="size-5 text-status-syncing" aria-hidden />}
        >
          Goodshuffle has no write API and Cloudflare blocks our server, so the import runs from your logged-in{" "}
          <code className="text-foreground">pro.goodshuffle.com</code> tab via a generated bookmarklet — not from this screen.
          Zoe can&apos;t observe that run, so there is no progress bar here; the importer itself dry-runs first, asks you to
          confirm, paces under the rate limit, re-checks Zoe&apos;s live catalog so re-running never duplicates, and logs
          progress to the browser console.
        </StatusBanner>

        <div className="mt-4">
          {exec.status === "no-plan" ? (
            <p className="text-[12.5px] text-meta">{exec.reason}</p>
          ) : exec.status === "nothing" ? (
            <p className="text-[12.5px] text-meta">{exec.reason}</p>
          ) : exec.status === "blocked" ? (
            <StatusBanner tone="critical" title="Can't generate the importer yet">
              {exec.reason}
            </StatusBanner>
          ) : (
            <div className="space-y-2">
              <p className="text-[12px] text-meta">
                Run this in your logged-in Goodshuffle tab. It will create {exec.count} item{exec.count === 1 ? "" : "s"} —
                unpriced, untracked, website + marketplace visible — uploading each photo.
              </p>
              <CopyBox
                label={`Importer bookmarklet (${exec.count} item${exec.count === 1 ? "" : "s"})`}
                value={importerBookmarklet ?? ""}
                hint="Creates items via a two-step /app/inventory/saveRegularItem. Each photo is sent in BOTH images[] and temporaryImages[] (the attach trigger). Dry-run first; then run for real."
              />
            </div>
          )}

          {/* Photo backfill — attach photos to items ALREADY in Zoe that have none */}
          {plan && backfillItems.length > 0 && (
            <div className="mt-5 border-t border-rule pt-4">
              <div className="mb-2 flex items-center gap-2 text-[12.5px] font-medium text-foreground">
                <ImageIcon className="size-3.5 text-meta" /> Backfill photos (optional)
              </div>
              <p className="mb-2 text-[12px] text-meta">
                A separate pass for items <strong className="text-tertiary-text">already in Zoe&apos;s inventory</strong> that have no
                photo. It never creates items: for each of the {backfillItems.length} source item{backfillItems.length === 1 ? "" : "s"} with photos,
                it looks the item up by title and, if it exists with no photo, uploads the partner&apos;s photos. Idempotent — it
                skips anything that already has a photo, so it is safe to re-run.
              </p>
              <CopyBox
                label={`Backfill-photos bookmarklet (${backfillItems.length} candidate${backfillItems.length === 1 ? "" : "s"})`}
                value={backfillBookmarklet ?? ""}
                hint="POST /app/inventory/searchInventoryItems → match by title → skip if it already has a photo → upload + saveRegularItem with images[] + temporaryImages[]. Dry-run first; then run for real."
              />
            </div>
          )}

          {/* Technical help — the API / Cloudflare / roadmap detail, out of the main flow */}
          <details className="mt-5 rounded-md border border-border">
            <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[12px] text-tertiary-text">
              <Terminal className="size-3.5 text-meta" aria-hidden /> How the write works (technical)
            </summary>
            <div className="space-y-2 border-t border-rule px-3 py-2.5 text-[12px] text-meta">
              <p>
                Each group&apos;s Goodshuffle category id is resolved from the Zoe-category registry, so there is no capture
                step — the importer uses the verified create/update + image-presign payloads. It fails closed: a group with no
                resolved category id blocks generation rather than guessing.
              </p>
              <p>
                <strong className="text-tertiary-text">Not yet built:</strong> hands-off execution that stages{" "}
                <code className="text-tertiary-text">item_create</code> / <code className="text-tertiary-text">item_image_upload</code>{" "}
                ops on the <code className="text-tertiary-text">gs_outbox</code> for the office Auto-Pull to drain automatically.
                Until then, the bookmarklet above is the supported path.
              </p>
            </div>
          </details>
        </div>
      </Surface>
    </>
  );

  const rail = <JobRail steps={steps} partner={partner} adding={adding} selectedGroups={selected.size} tags={tags} summary={summary} exec={exec} />;

  return (
    <BladeMain>
      <PageHeader
        title="Inventory Import"
        icon={<Boxes className="size-5" />}
        subtitle="Bulk-copy a partner's Goodshuffle storefront into Zoe's inventory for sub-rental. This previews the plan; the write runs from your own logged-in Goodshuffle tab."
      />
      <FocusFormLayout form={<div className="space-y-4">{form}</div>} summary={rail} />
    </BladeMain>
  );
}

// ── summary rail ──────────────────────────────────────────────────────────────────────────────────────

function JobRail({
  steps,
  partner,
  adding,
  selectedGroups,
  tags,
  summary,
  exec,
}: {
  steps: StepInfo[];
  partner: InventoryPartner | null;
  adding: boolean;
  selectedGroups: number;
  tags: string[];
  summary: ReturnType<typeof summarizePlan> | null;
  exec: ReturnType<typeof executionState>;
}): React.JSX.Element {
  return (
    <>
      {/* Step tracker */}
      <Surface pad="md">
        <div className="mb-2.5 text-[11px] uppercase tracking-[0.08em] text-meta">Steps</div>
        <ol className="space-y-2.5">
          {steps.map((s) => {
            const dot =
              s.state === "done" ? "bg-status-ready text-status-symbol" : s.state === "current" ? "bg-foreground text-background" : "border border-border text-meta";
            return (
              <li key={s.key} className="flex items-start gap-2.5">
                <span className={`mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] tabular-nums ${dot}`} aria-hidden>
                  {s.state === "done" ? <Check className="size-3" /> : s.state === "locked" ? <Lock className="size-2.5" /> : s.index}
                </span>
                <div className="min-w-0">
                  <div className={`text-[12.5px] ${s.state === "locked" ? "text-meta" : "text-foreground"}`}>{s.index}. {s.label}</div>
                  {s.detail && <div className="text-[11px] text-meta">{s.detail}</div>}
                </div>
              </li>
            );
          })}
        </ol>
      </Surface>

      {/* Job summary */}
      <Surface pad="md">
        <div className="mb-2.5 text-[11px] uppercase tracking-[0.08em] text-meta">Job summary</div>
        <dl className="space-y-2 text-[12px]">
          <RailRow label="Partner" value={adding ? "adding…" : partner?.name ?? "none selected"} muted={!partner || adding} />
          <RailRow label="Groups" value={partner && !adding ? `${selectedGroups} selected` : "—"} muted={!partner || adding} />
          <RailRow label="Tags" value={tags.length ? tags.join(", ") : "none"} muted={!tags.length} />
          {summary && <RailRow label="To create" value={String(summary.toCreate)} />}
          {summary && <RailRow label="Photos" value={String(summary.totalPhotos)} />}
        </dl>
      </Surface>

      {/* Execution readiness */}
      <Surface pad="md">
        <div className="mb-2 text-[11px] uppercase tracking-[0.08em] text-meta">Write readiness</div>
        <StatusBadge
          tone={exec.status === "ready" ? "positive" : exec.status === "blocked" ? "critical" : "neutral"}
          size="sm"
        >
          {exec.status === "ready" ? "Ready to write" : exec.status === "blocked" ? "Blocked" : exec.status === "nothing" ? "Nothing to write" : "Preview first"}
        </StatusBadge>
        <p className="mt-2 text-[11px] text-meta">{exec.reason}</p>
      </Surface>
    </>
  );
}

function RailRow({ label, value, muted }: { label: string; value: string; muted?: boolean }): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-2">
      <dt className="shrink-0 text-meta">{label}</dt>
      <dd className={`min-w-0 break-words text-right ${muted ? "text-meta" : "font-medium text-secondary-text"}`}>{value}</dd>
    </div>
  );
}

function SourceFact({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="rounded-md border border-border bg-row px-3 py-2">
      <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.06em] text-meta"><span className="text-meta" aria-hidden>{icon}</span>{label}</div>
      <div className="mt-1 truncate text-[12.5px] text-foreground" title={typeof value === "string" ? value : undefined}>{value}</div>
    </div>
  );
}

// The fixed v1 import policy, shown as explicit effects (icon + what it does). Preserved verbatim — these
// are NOT styling-adjustable defaults.
function PolicyEffects(): React.JSX.Element {
  const effects: { icon: React.ReactNode; label: string; detail: string }[] = [
    { icon: <DollarSign className="size-3.5" />, label: "Unpriced", detail: "no price copied" },
    { icon: <Hash className="size-3.5" />, label: "Quantity not tracked", detail: "created untracked" },
    { icon: <Globe className="size-3.5" />, label: "Website + marketplace", detail: "listed / visible" },
    { icon: <ImageIcon className="size-3.5" />, label: "Photos", detail: "copied when present" },
    { icon: <CopyX className="size-3.5" />, label: "Duplicates", detail: "skipped by title" },
  ];
  return (
    <ul className="flex flex-wrap gap-1.5">
      {effects.map((e) => (
        <li key={e.label} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-row px-2 py-1 text-[11.5px]">
          <span className="text-meta" aria-hidden>{e.icon}</span>
          <span className="text-foreground">{e.label}</span>
          <span className="text-meta">· {e.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function prettyHost(url: string): string {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).host;
  } catch {
    return url;
  }
}

// ── Add-partner flow ─────────────────────────────────────────────────────────────────────────────────────
// Paste a storefront link → resolve the vendor token (/api/inventory/resolve-partner) → list the catalog's
// groups (/api/inventory/catalog) → map each to a Zoe category + base tag → save (/api/inventory/partners).

interface MappingDraft {
  include: boolean;
  slug: string;
  name: string;
  count: number;
  targetCategory: string;
  baseTag: string;
}

function slugifyId(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function AddPartner({
  zoeCategories,
  existingIds,
  onCancel,
  onSaved,
}: {
  zoeCategories: ZoeCategory[];
  existingIds: string[];
  onCancel: () => void;
  onSaved: (newId: string) => void;
}): React.JSX.Element {
  const [input, setInput] = useState("");
  const [resolving, setResolving] = useState(false);
  const [resolveReason, setResolveReason] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [tokenSource, setTokenSource] = useState<string | null>(null);
  const [storefrontUrl, setStorefrontUrl] = useState("");

  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [mappings, setMappings] = useState<MappingDraft[]>([]);

  const [name, setName] = useState("");
  const [internalNote, setInternalNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const discover = useCallback(async (tok: string) => {
    setDiscovering(true);
    setDiscoverError(null);
    try {
      const res = await fetch("/api/inventory/catalog", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: tok }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string; groups: DiscoveredGroup[] };
      if (!res.ok || !data.ok) {
        setDiscoverError(data.error || `Could not read the catalog (HTTP ${res.status}).`);
        setMappings([]);
      } else {
        setMappings(
          data.groups.map((g) => ({
            include: false,
            slug: g.slug,
            name: g.name,
            count: g.count,
            targetCategory: "",
            baseTag: "",
          })),
        );
      }
    } catch (e) {
      setDiscoverError(e instanceof Error ? e.message : "Network error reading the catalog.");
    } finally {
      setDiscovering(false);
    }
  }, []);

  const resolve = useCallback(
    async (value: string) => {
      const v = value.trim();
      if (!v) return;
      setResolving(true);
      setResolveReason(null);
      try {
        const res = await fetch("/api/inventory/resolve-partner", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: v }),
        });
        const data = (await res.json()) as { ok: boolean; token?: string; source?: string; reason?: string };
        if (!res.ok || !data.ok || !data.token) {
          setResolveReason(data.reason || "Couldn't resolve that. Paste the partner's Goodshuffle data link or token.");
          setToken(null);
        } else {
          setToken(data.token);
          setTokenSource(data.source ?? null);
          setResolveReason(null);
          if (data.source === "url") setStorefrontUrl(/^https?:\/\//i.test(v) ? v : `https://${v}`);
          await discover(data.token);
        }
      } catch (e) {
        setResolveReason(e instanceof Error ? e.message : "Network error resolving the link.");
        setToken(null);
      } finally {
        setResolving(false);
      }
    },
    [discover],
  );

  const setMapping = (slug: string, patch: Partial<MappingDraft>) =>
    setMappings((prev) => prev.map((m) => (m.slug === slug ? { ...m, ...patch } : m)));

  const chosen = mappings.filter((m) => m.include);
  const canSave =
    !!token &&
    name.trim().length > 0 &&
    chosen.length > 0 &&
    chosen.every((m) => m.targetCategory.trim() && m.baseTag.trim());

  const save = useCallback(async () => {
    if (!token || !canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      let id = slugifyId(name) || `partner-${Date.now()}`;
      if (existingIds.includes(id)) id = `${id}-${Math.random().toString(36).slice(2, 6)}`;
      const partnerMappings: PartnerMapping[] = chosen.map((m) => ({
        key: slugifyId(m.name) || m.slug,
        label: m.name || m.slug,
        sourceGroups: [m.slug],
        targetCategory: m.targetCategory.trim(),
        baseTag: m.baseTag.trim(),
      }));
      const partner: InventoryPartner = {
        id,
        name: name.trim(),
        storefrontUrl: storefrontUrl.trim(),
        vendorToken: token,
        internalNote: internalNote.trim(),
        mappings: partnerMappings,
      };
      // Fetch the current list fresh so the POST sends the full set (never dropping other partners).
      let current: InventoryPartner[] = [];
      try {
        const cur = await fetch("/api/inventory/partners");
        if (cur.ok) current = ((await cur.json()) as { partners?: InventoryPartner[] }).partners ?? [];
      } catch {
        current = [];
      }
      const res = await fetch("/api/inventory/partners", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ partners: [...current, partner] }),
      });
      const data = (await res.json()) as { ok?: boolean; partners?: InventoryPartner[]; error?: string };
      if (!res.ok || !data.ok) {
        setSaveError(data.error || `Save failed (HTTP ${res.status}).`);
        return;
      }
      // The server may have adjusted the id (dedupe); find it by name.
      const saved = (data.partners ?? []).find((p) => p.name === partner.name);
      onSaved(saved?.id ?? id);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Network error saving the partner.");
    } finally {
      setSaving(false);
    }
  }, [token, canSave, name, chosen, storefrontUrl, internalNote, existingIds, onSaved]);

  const noCategories = zoeCategories.length === 0;

  return (
    <div className="mt-4 rounded-md border border-border bg-row/60 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-[13px] font-medium text-foreground"><Link2 className="size-4 text-meta" /> Add a partner</h3>
        <Button size="xs" variant="ghost" onClick={onCancel}><X className="size-3" /> Cancel</Button>
      </div>

      {/* Step 1: resolve */}
      <label className="mb-1.5 block text-[11px] uppercase tracking-[0.08em] text-meta">Partner&apos;s rental inventory link</label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void resolve(input);
            }
          }}
          placeholder="https://partner-storefront.com  (or a data.goodshuffle.com/vendor/… link, or a token)"
          aria-label="Partner's rental inventory link"
          className="min-w-[280px] flex-1 rounded-md border border-border bg-transparent px-3 py-2 text-[12.5px] text-foreground outline-none placeholder:text-meta focus:border-foreground/30"
        />
        <Button onClick={() => void resolve(input)} disabled={resolving || !input.trim()}>
          {resolving ? <Loader2 className="size-3.5 animate-spin" /> : <ChevronRight className="size-3.5" />}
          {resolving ? "Reading…" : "Find catalog"}
        </Button>
      </div>

      {resolveReason && (
        <div className="mt-2 rounded-md border border-border bg-row px-3 py-2 text-[12px] text-tertiary-text">
          <span className="inline-flex items-start gap-1.5"><AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-status-warning" aria-hidden /> {resolveReason}</span>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              defaultValue=""
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void resolve((e.target as HTMLInputElement).value);
                }
              }}
              placeholder="Paste data.goodshuffle.com/vendor/… or the token"
              aria-label="Paste a Goodshuffle data link or token"
              className="min-w-[280px] flex-1 rounded-md border border-border bg-transparent px-3 py-2 text-[12.5px] text-foreground outline-none placeholder:text-meta focus:border-foreground/30"
              id="partner-paste-fallback"
            />
            <Button
              size="sm"
              onClick={() => {
                const el = document.getElementById("partner-paste-fallback") as HTMLInputElement | null;
                if (el) void resolve(el.value);
              }}
            >
              Use this
            </Button>
          </div>
        </div>
      )}

      {token && (
        <div className="mt-3 flex items-center gap-2 text-[12px] text-meta">
          <Check className="size-3.5 text-status-ready" /> Resolved vendor token <code className="text-tertiary-text">{token}</code>
          {tokenSource && <span className="text-meta">(from {tokenSource === "url" ? "the storefront page" : tokenSource === "dataUrl" ? "a data link" : "a pasted token"})</span>}
        </div>
      )}

      {/* Step 2: map groups */}
      {token && (
        <div className="mt-4">
          {discovering ? (
            <div className="flex items-center gap-2 text-[12.5px] text-meta"><Loader2 className="size-3.5 animate-spin" /> Reading the partner&apos;s catalog…</div>
          ) : discoverError ? (
            <div className="rounded-md border border-critical/40 bg-critical/10 px-3 py-2 text-[12px] text-foreground">{discoverError}</div>
          ) : mappings.length === 0 ? (
            <p className="text-[12px] text-meta">No groups found in that catalog.</p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-[11px] uppercase tracking-[0.08em] text-meta">Partner name</label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Staging Design DC"
                    aria-label="Partner name"
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-[12.5px] text-foreground outline-none placeholder:text-meta focus:border-foreground/30"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-[11px] uppercase tracking-[0.08em] text-meta">Internal note (optional)</label>
                  <input
                    value={internalNote}
                    onChange={(e) => setInternalNote(e.target.value)}
                    placeholder="Stamped on every copied item, e.g. Subrent from …"
                    aria-label="Internal note"
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-[12.5px] text-foreground outline-none placeholder:text-meta focus:border-foreground/30"
                  />
                </div>
              </div>

              {noCategories && (
                <div className="mt-3 rounded-md border border-border bg-row px-3 py-2 text-[12px] text-tertiary-text">
                  <span className="inline-flex items-start gap-1.5"><AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-status-warning" aria-hidden /> No Zoe categories are configured yet. Add them in /admin (Inventory categories) first — each mapping needs a target category with a Goodshuffle id.</span>
                </div>
              )}

              <label className="mb-1.5 mt-4 block text-[11px] uppercase tracking-[0.08em] text-meta">Map the partner&apos;s groups to Zoe categories</label>
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full min-w-[520px] text-[12.5px]">
                  <thead>
                    <tr className="border-b border-rule text-left text-[10.5px] uppercase tracking-[0.06em] text-meta">
                      <th className="px-3 py-2 font-medium">Import</th>
                      <th className="px-3 py-2 font-medium">Partner group</th>
                      <th className="px-3 py-2 font-medium">Zoe category</th>
                      <th className="px-3 py-2 font-medium">Base tag</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mappings.map((m) => (
                      <tr key={m.slug} className="border-b border-rule/60 align-middle last:border-0">
                        <td className="px-3 py-2">
                          <Checkbox checked={m.include} onCheckedChange={() => setMapping(m.slug, { include: !m.include })} aria-label={`Import ${m.name}`} />
                        </td>
                        <td className="px-3 py-2 text-foreground">
                          {m.name}
                          <span className="ml-1 text-[11px] text-meta">{m.slug} &middot; {m.count}</span>
                        </td>
                        <td className="px-3 py-2">
                          <select
                            value={m.targetCategory}
                            onChange={(e) => setMapping(m.slug, { targetCategory: e.target.value })}
                            disabled={!m.include || noCategories}
                            aria-label={`Zoe category for ${m.name}`}
                            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-[12.5px] text-foreground outline-none focus:border-foreground/30 disabled:opacity-50"
                          >
                            <option value="">Select…</option>
                            {zoeCategories.map((c) => (
                              <option key={c.name} value={c.name}>{c.name}</option>
                            ))}
                          </select>
                        </td>
                        <td className="px-3 py-2">
                          <input
                            value={m.baseTag}
                            onChange={(e) => setMapping(m.slug, { baseTag: e.target.value })}
                            disabled={!m.include}
                            placeholder="e.g. Sofa"
                            aria-label={`Base tag for ${m.name}`}
                            className="w-28 rounded-md border border-border bg-transparent px-2 py-1.5 text-[12.5px] text-foreground outline-none placeholder:text-meta focus:border-foreground/30 disabled:opacity-50"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {saveError && (
                <div className="mt-3 rounded-md border border-critical/40 bg-critical/10 px-3 py-2 text-[12px] text-foreground">{saveError}</div>
              )}

              <div className="mt-3 flex items-center gap-3">
                <Button onClick={() => void save()} disabled={!canSave || saving}>
                  {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                  {saving ? "Saving…" : "Save partner"}
                </Button>
                {!canSave && !saving && (
                  <span className="text-[12px] text-meta">Pick at least one group and give each a Zoe category + base tag.</span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
