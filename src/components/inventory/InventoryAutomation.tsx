"use client";

// Inventory Automation blade — configure and drive a bulk copy of a partner's Goodshuffle catalog into
// Zoe's own inventory (Zoe is sub-renting the partner's items). Three stages, top to bottom:
//   1) CONFIGURE — pick the partner preset + which groups, edit the tags, see the fixed policy.
//   2) PREVIEW   — resolve the plan server-side (/api/inventory/plan): what would be created, what's
//      skipped as a duplicate, and honest warnings. No writes happen here.
//   3) WRITE     — the write endpoints are KNOWN and baked into the importer; the only per-target unknown
//      is Zoe's numeric category/group IDs, so the capture step is repurposed to learn those: the operator
//      creates ONE item in each target Goodshuffle group through the normal UI (capture tool running),
//      pastes the result, assigns each captured group to a target, and gets an importer bookmarklet.
//
// HONEST THROUGHOUT: the importer fails closed if a target group's IDs aren't resolved — it never guesses
// a category/group ID. Preview works with no capture.

import { useCallback, useMemo, useState } from "react";
import {
  Boxes, Copy, Check, Loader2, AlertTriangle, Info, Image as ImageIcon,
  PackagePlus, Download, Plus, X, RefreshCw, Tag as TagIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { PARTNER_PRESETS, ZOE_VENDOR_TOKEN } from "@/lib/inventory/partners";
import { buildCaptureBookmarklet, buildImporterBookmarklet, parseCapture, type GroupIdSet } from "@/lib/inventory/bookmarklets";
import type { PlanResponse } from "@/lib/inventory/service";

const DEFAULT_TAGS = ["Subrental", "Staging Design"];

/** Keyword for auto-matching a captured group to a target zoeGroup slug ("sofa-rentals" → "sofa"). */
function groupKeyword(zoeGroup: string): string {
  return zoeGroup.split("-")[0].replace(/s$/, "").toLowerCase();
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
  const preset = PARTNER_PRESETS[0]; // v1: Staging Design preselected (the only preset so far)
  const [selected, setSelected] = useState<Set<string>>(() => new Set(preset.mappings.map((m) => m.key)));
  const [tags, setTags] = useState<string[]>(DEFAULT_TAGS);
  const [tagInput, setTagInput] = useState("");

  const [loading, setLoading] = useState(false);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [captureText, setCaptureText] = useState("");
  const [overrides, setOverrides] = useState<Record<string, number>>({}); // zoeGroup -> chosen rootGroupID

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
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/inventory/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          partnerKey: preset.key,
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
  }, [preset.key, selected, tags]);

  const captureBookmarklet = useMemo(() => buildCaptureBookmarklet(), []);
  const captured = useMemo(() => (captureText.trim() ? parseCapture(captureText) : null), [captureText]);
  const sets = useMemo<GroupIdSet[]>(() => (captured?.ok ? captured.sets ?? [] : []), [captured]);

  const toCreate = useMemo(() => plan?.plan.toCreate ?? [], [plan]);
  const neededGroups = useMemo(() => Array.from(new Set(toCreate.map((i) => i.zoeGroup))), [toCreate]);
  const mappingByGroup = useMemo(() => {
    const m: Record<string, string> = {};
    for (const map of preset.mappings) m[map.zoeGroup] = map.label;
    return m;
  }, [preset.mappings]);

  // The resolved ID set for a target group: the operator's explicit choice, else an auto-match by name.
  const effectiveSet = useCallback(
    (zoeGroup: string): GroupIdSet | undefined => {
      const chosen = overrides[zoeGroup];
      if (chosen != null) return sets.find((s) => s.rootGroupID === chosen);
      const kw = groupKeyword(zoeGroup);
      return sets.find((s) => s.rootGroupName.toLowerCase().includes(kw));
    },
    [overrides, sets],
  );

  const groupIds = useMemo<Record<string, GroupIdSet>>(() => {
    const out: Record<string, GroupIdSet> = {};
    for (const g of neededGroups) {
      const s = effectiveSet(g);
      if (s) out[g] = s;
    }
    return out;
  }, [neededGroups, effectiveSet]);

  const unresolved = neededGroups.filter((g) => !effectiveSet(g));
  const canGenerate = toCreate.length > 0 && neededGroups.length > 0 && unresolved.length === 0;
  const importerBookmarklet = useMemo(() => {
    if (!canGenerate) return null;
    return buildImporterBookmarklet({ plan: toCreate, groupIds, zoeToken: ZOE_VENDOR_TOKEN });
  }, [canGenerate, toCreate, groupIds]);

  const groupLabel = (zoeGroup: string) => plan?.groups.find((g) => g.zoeGroup === zoeGroup)?.label ?? zoeGroup;

  return (
    <main className="max-w-[1100px] p-6">
      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight">
          <Boxes className="size-5 text-meta" /> Inventory Automation
        </h1>
        <p className="mt-1 text-[13px] text-meta">
          Bulk-copy a partner&apos;s Goodshuffle catalog into Zoe&apos;s own inventory for sub-rental. Preview the plan
          here; the actual writes run from your logged-in Goodshuffle tab (Goodshuffle has no write API).
        </p>
      </header>

      {/* 1) CONFIGURE */}
      <section className="mb-6">
        <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">1. Configure the job</h2>
        <div className="rounded border border-border p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-[11px] uppercase tracking-[0.08em] text-meta">Partner</label>
              <div className="flex items-center gap-2 rounded border border-border bg-[var(--row-hover)] px-3 py-2 text-[13px] text-foreground">
                <PackagePlus className="size-4 text-meta" /> {preset.label}
              </div>
              <p className="mt-1 text-[11px] text-meta">More partners can be added as presets later.</p>
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] uppercase tracking-[0.08em] text-meta">Groups to import</label>
              <div className="flex flex-col gap-1.5">
                {preset.mappings.map((m) => (
                  <label key={m.key} className="flex cursor-pointer items-center gap-2 text-[13px] text-foreground">
                    <Checkbox checked={selected.has(m.key)} onCheckedChange={() => toggleGroup(m.key)} />
                    {m.label} <span className="text-[11px] text-meta">&rarr; {m.zoeGroup}</span>
                  </label>
                ))}
              </div>
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

      {error && (
        <div className="mb-6 flex items-start gap-2 rounded border border-critical/40 bg-critical/10 px-3 py-2.5 text-[12.5px] text-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-critical" /> {error}
        </div>
      )}

      {/* 2) PREVIEW */}
      {plan && (
        <section className="mb-6">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">2. Plan preview</h2>
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
                <div className="text-[11px] text-meta">source items &middot; {g.zoeExistingCount} already in Zoe</div>
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
                    <th className="px-3 py-2 font-medium">Target group</th>
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
      <section className="mb-6">
        <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">3. Write to Goodshuffle</h2>
        <div className="rounded border border-border p-4">
          <div className="mb-3 flex items-start gap-2 rounded border border-border bg-[var(--row-hover)] px-3 py-2.5 text-[12.5px] text-tertiary-text">
            <Info className="mt-0.5 size-3.5 shrink-0 text-meta" />
            <span>
              Goodshuffle has no public write API and Cloudflare blocks server calls, so writes run from your
              logged-in <code className="text-foreground">pro.goodshuffle.com</code> tab. The create-item and
              image-upload endpoints are known and built in. The only thing to resolve per target group is
              Goodshuffle&apos;s numeric category/group IDs, which you capture once below.
            </span>
          </div>

          {/* Step a — capture the category/group IDs */}
          <div className="mb-4">
            <h3 className="mb-1.5 text-[12.5px] font-medium text-foreground">a. Capture the category/group IDs (one time per group)</h3>
            <p className="mb-2 text-[12px] text-meta">
              Copy this bookmarklet, open a logged-in Goodshuffle tab, paste it into the address bar and run it.
              A small panel appears. Then create ONE item in each target group you&apos;re importing (one Sofa under
              the Sofas group, one Barstool under the Barstools group) the normal way. Click
              <strong className="text-tertiary-text"> Copy captured</strong> and paste the result below. This reads the
              real category/group IDs so the importer puts items in the right website groups.
            </p>
            <CopyBox label="Capture bookmarklet" value={captureBookmarklet} hint="Runs only in your Goodshuffle tab. It records write requests to localStorage and never sends anything anywhere." />
          </div>

          {/* Step b — paste capture + assign groups */}
          <div className="mb-4">
            <h3 className="mb-1.5 text-[12.5px] font-medium text-foreground">b. Paste the captured item save(s)</h3>
            <textarea
              value={captureText}
              onChange={(e) => setCaptureText(e.target.value)}
              placeholder='Paste the JSON from "Copy captured" here...'
              className="block h-28 w-full resize-y rounded border border-border bg-transparent px-3 py-2 font-mono text-[11px] text-foreground outline-none placeholder:text-meta focus:border-foreground/30"
            />
            {captured && !captured.ok && (
              <p className="mt-1.5 flex items-start gap-1.5 text-[12px] text-attention"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {captured.error}</p>
            )}
            {captured?.ok && (
              <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-positive">
                <Check className="size-3.5" /> Resolved {sets.length} group{sets.length === 1 ? "" : "s"}: {sets.map((s) => `${s.rootGroupName || "(unnamed)"} #${s.rootGroupID}`).join(", ")}
              </p>
            )}

            {/* Per-target-group assignment (only meaningful once there's a plan) */}
            {neededGroups.length > 0 && (
              <div className="mt-3 rounded border border-border">
                <div className="border-b border-[var(--row-rule)] px-3 py-1.5 text-[11px] uppercase tracking-[0.08em] text-meta">Assign each target group to a captured Goodshuffle group</div>
                {neededGroups.map((g) => {
                  const chosen = effectiveSet(g);
                  return (
                    <div key={g} className="flex items-center gap-3 border-t border-[var(--row-rule)] px-3 py-2 text-[12.5px] first:border-t-0">
                      <span className="w-28 shrink-0 text-foreground">{mappingByGroup[g] ?? g}</span>
                      <select
                        value={chosen?.rootGroupID ?? ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          setOverrides((prev) => ({ ...prev, [g]: Number(v) }));
                        }}
                        disabled={sets.length === 0}
                        className="min-w-0 flex-1 rounded border border-border bg-transparent px-2 py-1 text-[12px] text-foreground outline-none focus:border-foreground/30 disabled:opacity-50"
                      >
                        <option value="">{sets.length === 0 ? "Paste a capture above first" : "Select captured group..."}</option>
                        {sets.map((s) => (
                          <option key={s.rootGroupID} value={s.rootGroupID} className="bg-sidebar text-foreground">
                            {(s.rootGroupName || "(unnamed group)")} &middot; {s.primaryCategoryName || "?"} &middot; #{s.rootGroupID}
                          </option>
                        ))}
                      </select>
                      {chosen ? <Check className="size-4 shrink-0 text-positive" /> : <span className="shrink-0 text-[11px] text-attention">needs IDs</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Step c — generate importer */}
          <div>
            <h3 className="mb-1.5 text-[12.5px] font-medium text-foreground">c. Generate the importer</h3>
            {!plan ? (
              <p className="text-[12px] text-meta">Preview a plan first (step 2) so there is something to import.</p>
            ) : toCreate.length === 0 ? (
              <p className="text-[12px] text-meta">The current plan has nothing to create, so there is no importer to generate.</p>
            ) : unresolved.length > 0 ? (
              <p className="text-[12px] text-meta">
                Resolve the category/group IDs for {unresolved.map((g) => mappingByGroup[g] ?? g).join(", ")} above to unlock the importer. It fails closed on a missing group ID (never guesses).
              </p>
            ) : (
              <>
                <p className="mb-2 text-[12px] text-meta">
                  Run this in your logged-in Goodshuffle tab. It confirms before writing, offers a dry run first,
                  re-checks Zoe&apos;s live catalog at run time (skips titles that already exist), uploads each photo,
                  and logs progress to the console. It will create {toCreate.length} item(s).
                </p>
                <CopyBox
                  label={`Importer bookmarklet (${toCreate.length} items)`}
                  value={importerBookmarklet ?? ""}
                  hint="Creates unpriced, untracked, website-visible items via /app/inventory/saveRegularItem. Dry-run first; then run for real."
                />
              </>
            )}
          </div>
        </div>
      </section>

      {/* Roadmap / honest scope */}
      <section className="text-[11.5px] text-meta">
        <div className="flex items-start gap-2">
          <Download className="mt-0.5 size-3.5 shrink-0" />
          <p>
            <strong className="text-tertiary-text">Coming next:</strong> hands-off execution — staging
            <code className="mx-1 text-tertiary-text">item_create</code>/<code className="mx-1 text-tertiary-text">item_image_upload</code>
            ops on the <code className="text-tertiary-text">gs_outbox</code> so the office Auto-Pull runs the plan
            automatically (no manual bookmarklet). And <strong className="text-tertiary-text">Cleanup jobs</strong>
            (bulk archive / retag / reprice) will live here too.
          </p>
        </div>
      </section>
    </main>
  );
}
