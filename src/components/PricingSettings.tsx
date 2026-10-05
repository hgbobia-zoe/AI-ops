"use client";

// Delivery pricing config editor for /admin (owner/admin; the write is enforced server-side and at the
// proxy settings gate). Edits the base fee, the tiered mileage ladder, the subtotal % + cap, and the
// route-engine knobs (share radius + timing tolerance). Mirrors the other /admin blocks: GET on mount,
// POST on Save, showing the honest default. The formula + route engine read exactly these values — there
// are no hard-coded pricing constants left in the code path.

import { useEffect, useState } from "react";
import { Loader2, Check, Plus, X } from "lucide-react";

interface MileageTier {
  uptoMile: number | null;
  ratePerMile: number;
}
interface PricingConfig {
  baseFee: number;
  mileageTiers: MileageTier[];
  pct: number;
  pctCap: number;
  routeRadiusMiles: number;
  timingToleranceMinutes: number;
}

const num = (v: string): number => Number(v.replace(/[^\d.]/g, "")) || 0;

export function PricingSettings(): React.JSX.Element {
  const [cfg, setCfg] = useState<PricingConfig | null>(null);
  const [def, setDef] = useState<PricingConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/pricing/config")
      .then((r) => r.json())
      .then((d: { config: PricingConfig; default: PricingConfig }) => {
        setCfg(d.config);
        setDef(d.default);
      })
      .catch(() => setError("Could not load the pricing config."));
  }, []);

  async function save(): Promise<void> {
    if (!cfg) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/pricing/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cfg),
      });
      if (!r.ok) {
        setError(r.status === 403 ? "You do not have permission to change this." : `Save failed (${r.status}).`);
        return;
      }
      const d = (await r.json()) as { config: PricingConfig };
      setCfg(d.config); // the merged, sanitized, stored truth
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2500);
    } catch {
      setError("Save failed — network error.");
    } finally {
      setBusy(false);
    }
  }

  function setTier(i: number, patch: Partial<MileageTier>): void {
    if (!cfg) return;
    const tiers = cfg.mileageTiers.map((t, idx) => (idx === i ? { ...t, ...patch } : t));
    setCfg({ ...cfg, mileageTiers: tiers });
  }
  function addTier(): void {
    if (!cfg) return;
    setCfg({ ...cfg, mileageTiers: [...cfg.mileageTiers, { uptoMile: null, ratePerMile: 0 }] });
  }
  function removeTier(i: number): void {
    if (!cfg || cfg.mileageTiers.length <= 1) return;
    setCfg({ ...cfg, mileageTiers: cfg.mileageTiers.filter((_, idx) => idx !== i) });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        The delivery fee is charged per leg: a flat base, a tiered per-mile charge, and a percentage of the pre-discount
        subtotal (capped). The route optimizer uses the share radius and timing tolerance to decide when a quote can ride
        along an existing same-day route.
      </p>

      {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-2.5 text-sm text-red-300">{error}</div>}

      {cfg == null ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <LabeledNum label="Base fee ($/leg)" value={cfg.baseFee} onChange={(v) => setCfg({ ...cfg, baseFee: v })} />
            <LabeledNum
              label="Subtotal fee (%)"
              value={Math.round(cfg.pct * 1000) / 10}
              onChange={(v) => setCfg({ ...cfg, pct: v / 100 })}
            />
            <LabeledNum label="Subtotal fee cap ($/leg)" value={cfg.pctCap} onChange={(v) => setCfg({ ...cfg, pctCap: v })} />
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium">Mileage tiers (cumulative by band)</div>
            <p className="text-xs text-muted-foreground">
              Each band charges its rate for the miles up to its boundary. Leave the last band&apos;s &ldquo;up to&rdquo; blank —
              it&apos;s open-ended (saving reorders the bands and forces the final one open-ended).
            </p>
            <div className="space-y-2">
              {cfg.mileageTiers.map((t, i) => (
                <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Up to mile</label>
                    <input
                      value={t.uptoMile ?? ""}
                      placeholder="open-ended"
                      inputMode="decimal"
                      onChange={(e) => setTier(i, { uptoMile: e.target.value.trim() === "" ? null : num(e.target.value) })}
                      className="w-full rounded-xl border border-white/10 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Rate ($/mi)</label>
                    <input
                      value={t.ratePerMile}
                      inputMode="decimal"
                      onChange={(e) => setTier(i, { ratePerMile: num(e.target.value) })}
                      className="w-full rounded-xl border border-white/10 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeTier(i)}
                    disabled={cfg.mileageTiers.length <= 1}
                    className="mb-0.5 inline-flex size-9 items-center justify-center rounded-xl border border-white/15 text-muted-foreground hover:bg-accent disabled:opacity-40"
                    aria-label="Remove tier"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addTier}
              className="inline-flex items-center gap-1.5 rounded-xl border border-white/15 px-3 py-1.5 text-xs hover:bg-accent"
            >
              <Plus className="size-3.5" /> Add tier
            </button>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <LabeledNum
              label="Route share radius (mi)"
              value={cfg.routeRadiusMiles}
              onChange={(v) => setCfg({ ...cfg, routeRadiusMiles: v })}
              hint="How close a same-day job must be to share a route."
            />
            <LabeledNum
              label="Timing tolerance (min)"
              value={cfg.timingToleranceMinutes}
              onChange={(v) => setCfg({ ...cfg, timingToleranceMinutes: v })}
              hint="Max extra drive-time an insertion may add (enforced only when the other job's window is known)."
            />
          </div>

          {def != null && (
            <p className="text-xs text-muted-foreground">
              Defaults: {`$${def.baseFee}`} base, {Math.round(def.pct * 1000) / 10}% (cap ${def.pctCap}), radius {def.routeRadiusMiles} mi,
              tolerance {def.timingToleranceMinutes} min.
            </p>
          )}

          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="btn-hero inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : justSaved ? <Check className="size-4" /> : null}
            {justSaved ? "Saved" : "Save pricing"}
          </button>
        </>
      )}
    </div>
  );
}

function LabeledNum({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  hint?: string;
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">{label}</label>
      <input
        value={value}
        inputMode="decimal"
        onChange={(e) => onChange(num(e.target.value))}
        className="w-full rounded-xl border border-white/10 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
