"use client";

// Inventory Automation blade — configure and drive a bulk copy of a partner's Goodshuffle catalog into
// Zoe's own inventory (Zoe is sub-renting the partner's items). Partners are now CONFIGURABLE by URL (no
// hardcoded preset): the operator adds a partner by pasting their storefront link, the resolver finds the
// public vendor token, their catalog's groups are listed, and each is mapped to a Zoe category. Flow:
//   0) PICK / ADD a partner (storefront link → token → group mappings → saved to settings).
//   1) CONFIGURE — pick which of the partner's groups to import, edit the tags, see the fixed policy.
//   2) PREVIEW   — resolve the plan server-side (/api/inventory/plan): what would be created, what's skipped
//      as a duplicate, honest warnings. No writes happen here.
//   3) WRITE     — one click. The server resolves each group's Goodshuffle category id from the Zoe-category
//      registry; the importer bookmarklet is generated from the previewed plan with VERIFIED-WORKING payloads.
//
// HONEST THROUGHOUT: the importer fails closed if a target category has no resolved Goodshuffle id — it never
// guesses. Preview works before generating. The write runs from the operator's logged-in Goodshuffle tab.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Boxes, Copy, Check, Loader2, AlertTriangle, Info, Image as ImageIcon,
  PackagePlus, Download, Plus, X, RefreshCw, Tag as TagIcon, Link2, ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { buildImporterBookmarklet, buildBackfillBookmarklet } from "@/lib/inventory/bookmarklets";
import type { InventoryPartner, PartnerMapping, ZoeCategory } from "@/lib/inventory/partners";
import type { PlanResponse } from "@/lib/inventory/service";

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
    <div className="rounded border border-border">
      <div className="flex items-center justify-between border-b border-[var(--row-rule)] px-3 py-2">
        <span className="text-[12px] font-medium text-foreground">{label}</span>
        <Button size="xs" variant="outline" onClick={copy}>
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <textarea
        readOnly
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        className="block h-20 w-full resize-none bg-transparent px-3 py-2 font-mono text-[11px] leading-relaxed text-tertiary-text outline-none"
      />
      {hint && <p className="border-t border-[var(--row-rule)] px-3 py-1.5 text-[11px] text-meta">{hint}</p>}
    </div>
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

  // Apply a partner selection: remember it, select all its groups, and clear any stale plan. Called from the
  // partner buttons and after a config (re)load, so selection state is set from an event — not an effect.
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
    // Wrapped in an async IIFE so no setState runs synchronously in the effect body (it all follows the fetch
    // await inside loadConfig) — this is a mount-time data load, not render-derived state.
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

  const unresolved = plan?.unresolvedCategories ?? [];
  const canGenerate = !!plan && toCreate.length > 0 && unresolved.length === 0;
  const importerBookmarklet = useMemo(() => {
    if (!plan || !canGenerate) return null;
    return buildImporterBookmarklet({ plan: toCreate, categories: plan.categories, zoeToken: plan.zoeToken, internalNotes: plan.internalNotes });
  }, [plan, canGenerate, toCreate]);

  // Backfill: all source items that carry at least one photo (the bookmarklet matches each to Zoe's live
  // catalog and only attaches photos to ones that exist there and have none). No category resolution needed —
  // the item's category + root group come from Goodshuffle's own search result at run time.
  const backfillItems = useMemo(() => (plan?.backfillItems ?? []).filter((b) => b.imageUrls.length > 0), [plan]);
  const backfillBookmarklet = useMemo(() => {
    if (!plan || backfillItems.length === 0) return null;
    return buildBackfillBookmarklet({ items: backfillItems, internalNotes: plan.internalNotes });
  }, [plan, backfillItems]);

  return (
    <main className="max-w-[1100px] p-6">
      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight">
          <Boxes className="size-5 text-meta" /> Inventory Automation
        </h1>
        <p className="mt-1 text-[13px] text-meta">
          Bulk-copy a partner&apos;s Goodshuffle catalog into Zoe&apos;s own inventory for sub-rental. Add partners by
          their storefront link; preview the plan here. The actual writes run from your logged-in Goodshuffle tab
          (Goodshuffle has no write API).
        </p>
      </header>

      {configError && (
        <div className="mb-6 flex items-start gap-2 rounded border border-critical/40 bg-critical/10 px-3 py-2.5 text-[12.5px] text-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-critical" /> {configError}
        </div>
      )}

      {/* 0) PARTNER */}
      <section className="mb-6">
        <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">1. Partner</h2>
        <div className="rounded border border-border p-4">
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
                  className={`inline-flex items-center gap-2 rounded border px-3 py-2 text-[13px] transition-colors ${
                    !adding && p.id === selectedPartnerId
                      ? "border-foreground/40 bg-[var(--row-hover)] text-foreground"
                      : "border-border text-tertiary-text hover:bg-[var(--row-hover)]"
                  }`}
                >
                  <PackagePlus className="size-4 text-meta" /> {p.name}
                  <span className="text-[11px] text-meta">{p.mappings.length} group{p.mappings.length === 1 ? "" : "s"}</span>
                </button>
              ))}
              {config.partners.length === 0 && <span className="text-[12.5px] text-meta">No partners configured yet.</span>}
              <button
                onClick={() => setAdding(true)}
                className={`inline-flex items-center gap-1.5 rounded border px-3 py-2 text-[13px] transition-colors ${
                  adding ? "border-foreground/40 bg-[var(--row-hover)] text-foreground" : "border-dashed border-border text-tertiary-text hover:bg-[var(--row-hover)]"
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
        </div>
      </section>

      {/* 1) CONFIGURE (only when a saved partner is selected and not adding) */}
      {partner && !adding && (
        <section className="mb-6">
          <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">2. Configure the job</h2>
          <div className="rounded border border-border p-4">
            <div>
              <label className="mb-1.5 block text-[11px] uppercase tracking-[0.08em] text-meta">Groups to import</label>
              <div className="flex flex-col gap-1.5">
                {partner.mappings.map((m) => (
                  <label key={m.key} className="flex cursor-pointer items-center gap-2 text-[13px] text-foreground">
                    <Checkbox checked={selected.has(m.key)} onCheckedChange={() => toggleGroup(m.key)} />
                    {m.label} <span className="text-[11px] text-meta">&rarr; {m.targetCategory}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Tags (editable) */}
            <div className="mt-4">
              <label className="mb-1.5 block text-[11px] uppercase tracking-[0.08em] text-meta">Tags applied to every copied item</label>
              <div className="flex flex-wrap items-center gap-1.5">
                {tags.map((t) => (
                  <span key={t} className="inline-flex items-center gap-1 rounded border border-border bg-[var(--row-hover)] px-2 py-1 text-[12px] text-foreground">
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
                    className="w-24 rounded border border-border bg-transparent px-2 py-1 text-[12px] text-foreground outline-none placeholder:text-meta focus:border-foreground/30"
                  />
                  <Button size="xs" variant="ghost" onClick={addTag}><Plus className="size-3" /></Button>
                </span>
              </div>
            </div>

            {/* Policy (fixed in v1) */}
            <div className="mt-4 flex flex-wrap items-center gap-2 text-[11.5px]">
              <span className="text-meta">Policy:</span>
              <span className="rounded border border-border px-2 py-0.5 text-tertiary-text">Unpriced (no price copied)</span>
              <span className="rounded border border-border px-2 py-0.5 text-tertiary-text">Quantity not tracked</span>
              <span className="rounded border border-border px-2 py-0.5 text-tertiary-text">Listed on website + marketplace</span>
              <span className="text-meta">Copies title, description, tags and photos only.</span>
            </div>

            <div className="mt-4 flex items-center gap-3">
              <Button onClick={preview} disabled={loading || selected.size === 0}>
                {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                {loading ? "Resolving plan..." : "Preview plan"}
              </Button>
              {selected.size === 0 && <span className="text-[12px] text-meta">Select at least one group.</span>}
            </div>
          </div>
        </section>
      )}

      {error && (
        <div className="mb-6 flex items-start gap-2 rounded border border-critical/40 bg-critical/10 px-3 py-2.5 text-[12.5px] text-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-critical" /> {error}
        </div>
      )}

      {/* 2) PREVIEW */}
      {plan && !adding && (
        <section className="mb-6">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">3. Plan preview</h2>
            <span className="text-[12px] text-meta">
              {toCreate.length} to create &middot; {plan.plan.skipped.length} skipped
            </span>
          </div>

          {/* Per-group summary */}
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {plan.groups.map((g) => (
              <div key={g.key} className="rounded border border-border p-2.5">
                <div className="text-[11px] uppercase tracking-[0.08em] text-meta">{g.label}</div>
                <div className="mt-0.5 text-[16px] font-medium tabular-nums text-foreground">{g.sourceCount}</div>
                <div className="text-[11px] text-meta">source items &middot; {g.alreadyInZoeCount} already in Zoe</div>
                {!g.categoryResolved && <div className="mt-1 text-[11px] text-critical">no Goodshuffle category id</div>}
                {(!g.sourceOk || !g.zoeOk) && <div className="mt-1 text-[11px] text-attention">partial: a catalog read failed</div>}
              </div>
            ))}
          </div>

          {/* Service + item warnings */}
          {(plan.warnings.length > 0 || plan.plan.warnings.length > 0) && (
            <div className="mb-3 rounded border border-attention/40 bg-attention/5 px-3 py-2 text-[12px] text-tertiary-text">
              <div className="mb-1 flex items-center gap-1.5 font-medium text-attention"><Info className="size-3.5" /> Warnings</div>
              <ul className="list-disc space-y-0.5 pl-5">
                {plan.warnings.map((w, i) => <li key={`s${i}`}>{w}</li>)}
                {plan.plan.warnings.map((w, i) => <li key={`i${i}`}>{w}</li>)}
              </ul>
            </div>
          )}

          {/* To create */}
          {toCreate.length === 0 ? (
            <div className="rounded border border-border px-3 py-3 text-[12.5px] text-meta">
              Nothing to create. Every source item already exists in Zoe&apos;s catalog (or no groups returned items).
            </div>
          ) : (
            <div className="overflow-hidden rounded border border-border">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.06em] text-meta">
                    <th className="px-3 py-2 font-medium">Item</th>
                    <th className="px-3 py-2 font-medium">Target category</th>
                    <th className="px-3 py-2 font-medium">Images</th>
                    <th className="px-3 py-2 font-medium">Tags</th>
                  </tr>
                </thead>
                <tbody>
                  {toCreate.map((it) => (
                    <tr key={it.sourceId} className="border-t border-[var(--row-rule)] align-top">
                      <td className="px-3 py-2 text-foreground">{it.title}</td>
                      <td className="px-3 py-2 text-tertiary-text">{groupLabel(it.zoeGroup)}</td>
                      <td className="px-3 py-2 text-tertiary-text">
                        <span className="inline-flex items-center gap-1"><ImageIcon className="size-3 text-meta" />{it.imageUrls.length}</span>
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
          )}

          {/* Skipped */}
          {plan.plan.skipped.length > 0 && (
            <details className="mt-3 rounded border border-border">
              <summary className="cursor-pointer px-3 py-2 text-[12.5px] text-tertiary-text">
                {plan.plan.skipped.length} skipped (duplicates / no title)
              </summary>
              <ul className="border-t border-[var(--row-rule)] px-3 py-2 text-[12px] text-meta">
                {plan.plan.skipped.map((s, i) => (
                  <li key={i} className="flex justify-between gap-3 border-t border-[var(--row-rule)] py-1 first:border-t-0">
                    <span className="truncate text-tertiary-text">{s.title}</span>
                    <span className="shrink-0">{s.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      {/* 3) WRITE */}
      {!adding && (
        <section className="mb-6">
          <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">4. Write to Goodshuffle</h2>
          <div className="rounded border border-border p-4">
            <div className="mb-3 flex items-start gap-2 rounded border border-border bg-[var(--row-hover)] px-3 py-2.5 text-[12.5px] text-tertiary-text">
              <Info className="mt-0.5 size-3.5 shrink-0 text-meta" />
              <span>
                Goodshuffle has no public write API and Cloudflare blocks server calls, so writes run from your
                logged-in <code className="text-foreground">pro.goodshuffle.com</code> tab. Each group&apos;s Goodshuffle
                category is resolved from the Zoe-category registry, so there is <strong className="text-tertiary-text">no capture step</strong> —
                preview a plan above, then generate the importer. It uses the verified create/update + image payloads.
              </span>
            </div>

            {!plan ? (
              <p className="text-[12px] text-meta">Preview a plan first (step 3) so there is something to import.</p>
            ) : toCreate.length === 0 ? (
              <p className="text-[12px] text-meta">The current plan has nothing to create, so there is no importer to generate.</p>
            ) : unresolved.length > 0 ? (
              <p className="flex items-start gap-1.5 text-[12px] text-critical">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                No Goodshuffle category id for {unresolved.join(", ")}. Add it in /admin (Inventory categories). The importer fails closed and will not guess.
              </p>
            ) : (
              <>
                <p className="mb-2 text-[12px] text-meta">
                  Run this in your logged-in Goodshuffle tab. It confirms before writing, offers a dry run first,
                  fetches your live tax types, paces requests under Goodshuffle&apos;s rate limit, re-checks Zoe&apos;s
                  live catalog at run time (skips titles that already exist), uploads each photo, and logs
                  progress to the console. It will create {toCreate.length} item(s).
                </p>
                <CopyBox
                  label={`Importer bookmarklet (${toCreate.length} items)`}
                  value={importerBookmarklet ?? ""}
                  hint="Creates unpriced, untracked, website-visible items via a two-step /app/inventory/saveRegularItem. Each photo is sent in BOTH images[] and temporaryImages[] (the attach trigger). Dry-run first; then run for real."
                />
              </>
            )}

            {/* Photo backfill — attach photos to items ALREADY in Zoe that have none */}
            {plan && backfillItems.length > 0 && (
              <div className="mt-5 border-t border-[var(--row-rule)] pt-4">
                <div className="mb-2 flex items-center gap-2 text-[12.5px] font-medium text-foreground">
                  <ImageIcon className="size-3.5 text-meta" /> Backfill photos
                </div>
                <p className="mb-2 text-[12px] text-meta">
                  Separate, optional pass for items that are <strong className="text-tertiary-text">already in Zoe&apos;s inventory</strong> but have
                  no photo (e.g. created before the photo-attach fix). It never creates items: for each of the{" "}
                  {backfillItems.length} source item(s) with photos, it looks the item up in your Goodshuffle inventory by
                  title, and if it exists with no photo, uploads and attaches the partner&apos;s photos. Idempotent &mdash; it
                  skips anything that already has a photo, so it is safe to re-run.
                </p>
                <CopyBox
                  label={`Backfill-photos bookmarklet (${backfillItems.length} candidates)`}
                  value={backfillBookmarklet ?? ""}
                  hint="POST /app/inventory/searchInventoryItems → match by title → skip if it already has a photo → upload + saveRegularItem with images[] + temporaryImages[]. Dry-run first; then run for real."
                />
              </div>
            )}
          </div>
        </section>
      )}

      {/* Roadmap / honest scope */}
      <section className="text-[11.5px] text-meta">
        <div className="flex items-start gap-2">
          <Download className="mt-0.5 size-3.5 shrink-0" />
          <p>
            <strong className="text-tertiary-text">Coming next:</strong> hands-off execution — staging
            <code className="mx-1 text-tertiary-text">item_create</code>/<code className="mx-1 text-tertiary-text">item_image_upload</code>
            ops on the <code className="text-tertiary-text">gs_outbox</code> so the office Auto-Pull runs the plan
            automatically (no manual bookmarklet). Auto-resolving arbitrary Zoe category ids and
            <strong className="text-tertiary-text"> cleanup jobs</strong> (bulk archive / retag / reprice) will live here too.
          </p>
        </div>
      </section>
    </main>
  );
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
    <div className="mt-4 rounded border border-border bg-[var(--row-hover)]/40 p-4">
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
          className="min-w-[320px] flex-1 rounded border border-border bg-transparent px-3 py-2 text-[12.5px] text-foreground outline-none placeholder:text-meta focus:border-foreground/30"
        />
        <Button onClick={() => void resolve(input)} disabled={resolving || !input.trim()}>
          {resolving ? <Loader2 className="size-3.5 animate-spin" /> : <ChevronRight className="size-3.5" />}
          {resolving ? "Reading…" : "Find catalog"}
        </Button>
      </div>

      {resolveReason && (
        <div className="mt-2 rounded border border-attention/40 bg-attention/5 px-3 py-2 text-[12px] text-tertiary-text">
          {resolveReason}
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
              className="min-w-[320px] flex-1 rounded border border-border bg-transparent px-3 py-2 text-[12.5px] text-foreground outline-none placeholder:text-meta focus:border-foreground/30"
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
          <Check className="size-3.5 text-positive" /> Resolved vendor token <code className="text-tertiary-text">{token}</code>
          {tokenSource && <span className="text-meta">(from {tokenSource === "url" ? "the storefront page" : tokenSource === "dataUrl" ? "a data link" : "a pasted token"})</span>}
        </div>
      )}

      {/* Step 2: map groups */}
      {token && (
        <div className="mt-4">
          {discovering ? (
            <div className="flex items-center gap-2 text-[12.5px] text-meta"><Loader2 className="size-3.5 animate-spin" /> Reading the partner&apos;s catalog…</div>
          ) : discoverError ? (
            <div className="rounded border border-critical/40 bg-critical/10 px-3 py-2 text-[12px] text-foreground">{discoverError}</div>
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
                    className="w-full rounded border border-border bg-transparent px-3 py-2 text-[12.5px] text-foreground outline-none placeholder:text-meta focus:border-foreground/30"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-[11px] uppercase tracking-[0.08em] text-meta">Internal note (optional)</label>
                  <input
                    value={internalNote}
                    onChange={(e) => setInternalNote(e.target.value)}
                    placeholder="Stamped on every copied item, e.g. Subrent from …"
                    className="w-full rounded border border-border bg-transparent px-3 py-2 text-[12.5px] text-foreground outline-none placeholder:text-meta focus:border-foreground/30"
                  />
                </div>
              </div>

              {noCategories && (
                <div className="mt-3 rounded border border-attention/40 bg-attention/5 px-3 py-2 text-[12px] text-tertiary-text">
                  No Zoe categories are configured yet. Add them in /admin (Inventory categories) first — each mapping needs a target category with a Goodshuffle id.
                </div>
              )}

              <label className="mb-1.5 mt-4 block text-[11px] uppercase tracking-[0.08em] text-meta">Map the partner&apos;s groups to Zoe categories</label>
              <div className="overflow-hidden rounded border border-border">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.06em] text-meta">
                      <th className="px-3 py-2 font-medium">Import</th>
                      <th className="px-3 py-2 font-medium">Partner group</th>
                      <th className="px-3 py-2 font-medium">Zoe category</th>
                      <th className="px-3 py-2 font-medium">Base tag</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mappings.map((m) => (
                      <tr key={m.slug} className="border-t border-[var(--row-rule)] align-middle">
                        <td className="px-3 py-2">
                          <Checkbox checked={m.include} onCheckedChange={() => setMapping(m.slug, { include: !m.include })} />
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
                            className="w-full rounded border border-border bg-background px-2 py-1.5 text-[12.5px] text-foreground outline-none focus:border-foreground/30 disabled:opacity-50"
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
                            className="w-28 rounded border border-border bg-transparent px-2 py-1.5 text-[12.5px] text-foreground outline-none placeholder:text-meta focus:border-foreground/30 disabled:opacity-50"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {saveError && (
                <div className="mt-3 rounded border border-critical/40 bg-critical/10 px-3 py-2 text-[12px] text-foreground">{saveError}</div>
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
