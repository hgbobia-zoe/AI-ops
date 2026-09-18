"use client";

// Delivery pricing calculator — mirrors zoeeventsdmv.com/calculator. Rep enters the event address (we
// pull driving miles from the warehouse) and the quote subtotal (pre-discount); we price each leg as
// BASE + miles×$2.99 + subtotal×5%. Round trip charges both legs. Read-only math — nothing is saved.

import { useMemo, useState } from "react";
import { Calculator, Loader2, MapPin, Truck, Wrench } from "lucide-react";
import { deliveryQuote, PER_MILE, SUBTOTAL_PCT, BASE, type LegMode, type LegBreakdown } from "@/lib/pricing/delivery";
import { readinessTier } from "@/lib/pricing/eventReadiness";

const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const MODES: { value: LegMode; label: string }[] = [
  { value: "round_trip", label: "Round trip" },
  { value: "drop_off", label: "Drop-off only" },
  { value: "pickup", label: "Pickup only" },
];

export function DeliveryCalculator(): React.JSX.Element {
  const [address, setAddress] = useState("");
  const [miles, setMiles] = useState("");
  const [subtotal, setSubtotal] = useState("");
  const [mode, setMode] = useState<LegMode>("round_trip");
  const [readiness, setReadiness] = useState(false);
  const [loading, setLoading] = useState(false);
  const [distNote, setDistNote] = useState<string | null>(null);

  async function getMiles() {
    const a = address.trim();
    if (!a) return;
    setLoading(true);
    setDistNote(null);
    try {
      const r = await fetch(`/api/pricing/distance?address=${encodeURIComponent(a)}`);
      const j = (await r.json()) as { miles: number | null };
      if (j.miles != null) {
        setMiles(String(j.miles));
        setDistNote(`${j.miles} mi from the warehouse (driving)`);
      } else {
        setDistNote("Couldn't find that address — type the miles in by hand.");
      }
    } catch {
      setDistNote("Distance lookup failed — type the miles in by hand.");
    } finally {
      setLoading(false);
    }
  }

  const subtotalNum = Number(subtotal) || 0;
  const q = useMemo(() => deliveryQuote(Number(miles) || 0, subtotalNum, mode), [miles, subtotalNum, mode]);
  const rTier = useMemo(() => readinessTier(subtotalNum), [subtotalNum]);
  const grandTotal = Math.round((q.total + (readiness ? rTier.fee : 0)) * 100) / 100;
  const ready = (Number(miles) || 0) >= 0 && (miles !== "" || subtotal !== "");

  return (
    <main className="mx-auto max-w-2xl p-5 pb-24 md:p-8">
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <Calculator className="size-7" /> Delivery Pricing
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {money(BASE)} base + {money(PER_MILE)}/mile + {Math.round(SUBTOTAL_PCT * 100)}% of the pre-discount subtotal, per leg.
          The time-window upgrade (Standard / Premium / Exact) is a separate line item.
        </p>
      </header>

      <section className="surface space-y-4 rounded-2xl border border-white/5 p-5">
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Event address</label>
          <div className="flex gap-2">
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && getMiles()}
              placeholder="123 Main St, Bethesda, MD 20814"
              className="min-w-0 flex-1 rounded-xl border border-white/10 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <button
              onClick={getMiles}
              disabled={loading || !address.trim()}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-white/15 px-3 py-2 text-sm hover:bg-accent disabled:opacity-50"
            >
              {loading ? <Loader2 className="size-4 animate-spin" /> : <MapPin className="size-4" />}
              Get miles
            </button>
          </div>
          {distNote && <p className="text-xs text-muted-foreground">{distNote}</p>}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Miles (one way)</label>
            <input
              value={miles}
              onChange={(e) => setMiles(e.target.value.replace(/[^\d.]/g, ""))}
              inputMode="decimal"
              placeholder="e.g. 12"
              className="w-full rounded-xl border border-white/10 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Quote subtotal (before discount)</label>
            <input
              value={subtotal}
              onChange={(e) => setSubtotal(e.target.value.replace(/[^\d.]/g, ""))}
              inputMode="decimal"
              placeholder="e.g. 2000"
              className="w-full rounded-xl border border-white/10 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        </div>

        <div className="inline-flex rounded-xl border border-white/10 bg-white/[0.03] p-1 text-sm">
          {MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => setMode(m.value)}
              className={`rounded-lg px-3 py-1.5 font-medium transition-colors ${
                mode === m.value ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <input type="checkbox" checked={readiness} onChange={(e) => setReadiness(e.target.checked)} className="mt-0.5 size-4 accent-primary" />
          <span>
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <Wrench className="size-4 text-primary" /> Add Event Readiness (setup / breakdown help)
            </span>
            <span className="text-xs text-muted-foreground">Tiered by order value: under $500 $75 · $500–1,500 $150 · $1,500–3,000 $250 · $3,000+ $350+</span>
          </span>
        </label>
      </section>

      {/* Result */}
      <section className="surface mt-5 rounded-2xl border border-white/5 p-5">
        {ready ? (
          <div className="space-y-4">
            {q.dropOff && <LegRow title="Drop-off" leg={q.dropOff} />}
            {q.pickup && <LegRow title="Pickup" leg={q.pickup} />}
            <div className="flex items-center justify-between border-t border-white/10 pt-4">
              <span className="flex items-center gap-2 font-semibold">
                <Truck className="size-5 text-primary" /> Delivery {readiness ? "subtotal" : "total"}
              </span>
              <span className="text-xl font-bold tabular-nums">{money(q.total)}</span>
            </div>

            {readiness && (
              <>
                <div>
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 font-semibold">
                      <Wrench className="size-5 text-primary" /> Event Readiness
                    </span>
                    <span className="font-semibold tabular-nums">
                      {money(rTier.fee)}
                      {rTier.floor && <span className="text-muted-foreground">+</span>}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {rTier.max
                      ? `order ${money(rTier.min)}–${money(rTier.max)} tier`
                      : `orders ${money(rTier.min)}+ (starting price — large orders may run higher)`}
                  </div>
                </div>
                <div className="flex items-center justify-between border-t border-white/10 pt-4">
                  <span className="text-lg font-semibold">Grand total</span>
                  <span className="text-2xl font-bold tabular-nums">
                    {money(grandTotal)}
                    {rTier.floor && <span className="text-base text-muted-foreground">+</span>}
                  </span>
                </div>
              </>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Enter the miles and subtotal to see the price.</p>
        )}
      </section>
    </main>
  );
}

function LegRow({ title, leg }: { title: string; leg: LegBreakdown }): React.JSX.Element {
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="font-semibold">{title}</span>
        <span className="font-semibold tabular-nums">{money(leg.total)}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
        <span>base {money(leg.base)}</span>
        <span>mileage {money(leg.mileage)}</span>
        <span>subtotal fee {money(leg.subtotalFee)}</span>
      </div>
    </div>
  );
}
