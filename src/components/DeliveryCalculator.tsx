"use client";

// Delivery pricing calculator — mirrors zoeeventsdmv.com/calculator, now ROUTE-AWARE. The rep enters the
// event address + date + subtotal; the server geocodes the venue, finds the day's other signed delivery
// jobs, and DETERMINISTICALLY prices the run in one of three modes:
//   • STANDARD        — a standalone trip from the warehouse.
//   • ROUTE OPTIMIZED — the stop can share an existing same-day route, so it's billed on the INCREMENTAL
//                       distance it adds (lower).
//   • DEDICATED       — other jobs exist that day but none can share, so it's a dedicated trip.
// The formula (base + tiered mileage + a capped % of the pre-discount subtotal, per leg) and the route
// knobs come from the team-editable pricing config. RULES CALCULATE — nothing here calls an LLM. Unknowns
// (geocode/route failures, an unrouted anchor's unknown window) are surfaced, never invented. The customer
// sees only the final price; the route internals are labelled rep-only. No cost/margin is ever shown.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Calculator, Check, FolderOpen, Loader2, MapPin, Route as RouteIcon, Search, Send, Truck, Wrench } from "lucide-react";
import { deliveryQuote, type LegMode, type LegBreakdown, type MileageTier, type DeliveryQuote } from "@/lib/pricing/delivery";
import { readinessTier } from "@/lib/pricing/eventReadiness";
import { EXTENSION_ID } from "@/lib/extensionId";

const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const MODES: { value: LegMode; label: string }[] = [
  { value: "round_trip", label: "Round trip" },
  { value: "drop_off", label: "Drop-off only" },
  { value: "pickup", label: "Pickup only" },
];

type PricingMode = "STANDARD" | "ROUTE_OPTIMIZED" | "DEDICATED";

const MODE_BADGE: Record<PricingMode, { label: string; cls: string }> = {
  STANDARD: { label: "Standard", cls: "border-white/15 bg-white/[0.04] text-foreground" },
  ROUTE_OPTIMIZED: { label: "Route optimized", cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" },
  DEDICATED: { label: "Dedicated trip", cls: "border-amber-500/30 bg-amber-500/10 text-amber-300" },
};

interface ProjectOpt {
  id: string;
  name: string;
  clientName: string;
  subtotal: number | null;
  location: string | null;
  eventDate: string | null;
}

// Result of asking the Auto-Pull extension for the project's CURRENT pre-discount subtotal, live from a
// logged-in Goodshuffle session. We only ever trust a live number the extension actually returned.
interface LiveSubtotalResp {
  ok: boolean;
  subtotal?: number; // dollars (pre-discount contract_subtotal)
  pulledAt?: string; // ISO
  reason?: string;
}

// How the subtotal field's value was sourced, for an HONEST label under the field.
type SubtotalInfo = { state: "loading" | "live" | "stored"; text: string } | null;

/** Ask the installed Auto-Pull extension to read the project's current pre-discount subtotal from a
 *  logged-in Goodshuffle session. Resolves (never rejects) with ok:false when the extension isn't
 *  installed / not on this machine / signed out / slow — the page then keeps the stored value and labels
 *  it honestly. ~8s timeout; guards for a missing chrome.runtime. */
function requestLiveSubtotal(projectId: string): Promise<LiveSubtotalResp> {
  return new Promise((resolve) => {
    try {
      const rt = (globalThis as unknown as { chrome?: { runtime?: { sendMessage?: (id: string, msg: unknown, cb: (r: unknown) => void) => void; lastError?: unknown } } }).chrome?.runtime;
      if (!rt?.sendMessage) {
        resolve({ ok: false, reason: "no_extension" });
        return;
      }
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          resolve({ ok: false, reason: "timeout" });
        }
      }, 8000);
      rt.sendMessage(EXTENSION_ID, { type: "zoe-fetch-subtotal", projectId }, (resp: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        // Reading lastError clears Chrome's "Unchecked runtime.lastError" console noise when the
        // extension isn't there / didn't answer.
        const hadError = Boolean(rt.lastError);
        if (hadError || !resp || typeof resp !== "object") {
          resolve({ ok: false, reason: "unreachable" });
          return;
        }
        resolve(resp as LiveSubtotalResp);
      });
    } catch {
      resolve({ ok: false, reason: "error" });
    }
  });
}

interface RouteQuoteResp {
  ok: boolean;
  resolved: boolean;
  distanceSource: "geocoded" | "manual" | "unresolved";
  note?: string;
  pricingMode?: PricingMode;
  warehouseMiles?: number;
  billableMiles?: number;
  incrementalMiles?: number | null;
  savingsMiles?: number | null;
  anchor?: { id: string; label: string; truckId: string | null; source: "route" | "booking"; timingVerified: boolean } | null;
  anchorsConsidered?: number;
  reasons?: string[];
  quote?: DeliveryQuote;
  perLeg?: number;
  formula?: { baseFee: number; mileageTiers: MileageTier[]; pct: number; pctCap: number };
}

export function DeliveryCalculator(): React.JSX.Element {
  const [address, setAddress] = useState("");
  const [miles, setMiles] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [subtotal, setSubtotal] = useState("");
  const [mode, setMode] = useState<LegMode>("round_trip");
  const [readiness, setReadiness] = useState(false);
  const [loading, setLoading] = useState(false); // "Get miles" lookup
  const [pricing, setPricing] = useState(false); // route-quote in flight
  const [distNote, setDistNote] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string>("");
  const [pushing, setPushing] = useState(false);
  const [pushMsg, setPushMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [rq, setRq] = useState<RouteQuoteResp | null>(null);
  // Searchable project picker.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProjectOpt[]>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  // Live-subtotal freshness label (honest provenance of the subtotal field).
  const [subtotalInfo, setSubtotalInfo] = useState<SubtotalInfo>(null);
  const pickedLabelRef = useRef<string>(""); // skip re-searching for the label we just filled in
  const liveReqRef = useRef(0); // ignore a stale live-subtotal reply if the user picked another project

  // Debounced type-to-search against the staff-gated search endpoint (project #, name, or customer).
  useEffect(() => {
    const term = query.trim();
    if (term.length < 2 || term === pickedLabelRef.current) {
      setResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      fetch(`/api/pricing/projects/search?q=${encodeURIComponent(term)}`)
        .then((r) => r.json())
        .then((j: { projects: ProjectOpt[] }) => {
          if (cancelled) return;
          setResults(j.projects ?? []);
          setActiveIdx(0);
          setShowResults(true);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  const pickProject = useCallback((p: ProjectOpt) => {
    setProjectId(p.id);
    setPushMsg(null);
    if (p.location) setAddress(p.location);
    setSubtotal(p.subtotal != null ? String(p.subtotal) : "");
    if (p.eventDate) setEventDate(p.eventDate);
    const label = p.name + (p.clientName && p.clientName !== p.name ? ` · ${p.clientName}` : "") + ` · #${p.id}`;
    pickedLabelRef.current = label;
    setQuery(label);
    setResults([]);
    setShowResults(false);

    // Prefill with the STORED subtotal immediately (never blank), then ask the extension for the LIVE one.
    const reqId = ++liveReqRef.current;
    setSubtotalInfo({ state: "loading", text: "Checking Goodshuffle for the current subtotal…" });
    void requestLiveSubtotal(p.id).then((resp) => {
      if (reqId !== liveReqRef.current) return; // a newer selection superseded this one
      if (resp.ok && typeof resp.subtotal === "number" && Number.isFinite(resp.subtotal)) {
        setSubtotal(String(resp.subtotal));
        setSubtotalInfo({ state: "live", text: "live from Goodshuffle just now" });
      } else {
        setSubtotalInfo({
          state: "stored",
          text:
            p.subtotal != null
              ? "subtotal as of the last pull — couldn't reach Goodshuffle live"
              : "no stored subtotal on this project — enter it by hand",
        });
      }
    });
  }, []);

  const subtotalNum = Number(subtotal) || 0;

  // Local fallback quote (default formula) so the UI shows something instantly / if the route-quote errors.
  const localQuote = useMemo(() => deliveryQuote(Number(miles) || 0, subtotalNum, mode), [miles, subtotalNum, mode]);

  // The authoritative quote: the server's config-correct, mode-aware result when available, else local.
  const q: DeliveryQuote = rq?.resolved && rq.quote ? rq.quote : localQuote;
  const perLeg = rq?.resolved && rq.perLeg != null ? rq.perLeg : (localQuote.dropOff ?? localQuote.pickup)?.total ?? 0;
  const pricingMode: PricingMode | null = rq?.resolved ? rq.pricingMode ?? null : null;

  // Recompute the route-aware quote whenever an input that affects it changes (debounced; OSRM is rate-limited).
  const reqId = useRef(0);
  const runQuote = useCallback(async () => {
    const hasAddress = address.trim().length > 0;
    const milesNum = Number(miles);
    const hasMiles = miles.trim() !== "" && Number.isFinite(milesNum) && milesNum >= 0;
    if (!hasAddress && !hasMiles) {
      setRq(null);
      return;
    }
    const id = ++reqId.current;
    setPricing(true);
    try {
      const r = await fetch("/api/pricing/route-quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: address.trim() || undefined,
          miles: hasMiles ? milesNum : undefined,
          eventDate: eventDate || undefined,
          subtotal: subtotalNum,
          mode,
          projectId: projectId || undefined,
        }),
      });
      const j = (await r.json()) as RouteQuoteResp;
      if (id !== reqId.current) return; // a newer request superseded this one
      setRq(j);
      if (!j.resolved) {
        setDistNote(j.note ?? "Couldn't resolve the distance — type the miles in by hand.");
      } else if (j.distanceSource === "geocoded" && j.warehouseMiles != null) {
        setDistNote(`${j.warehouseMiles} mi from the warehouse (driving)`);
      } else if (j.distanceSource === "manual") {
        setDistNote(`Pricing on the ${j.warehouseMiles} mi you entered (couldn't geocode the address).`);
      }
    } catch {
      if (id === reqId.current) setRq(null);
    } finally {
      if (id === reqId.current) setPricing(false);
    }
  }, [address, miles, eventDate, subtotalNum, mode, projectId]);

  useEffect(() => {
    const t = setTimeout(() => void runQuote(), 500);
    return () => clearTimeout(t);
  }, [runQuote]);

  async function getMiles(addr?: string) {
    const a = (addr ?? address).trim();
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

  async function pushToGoodshuffle() {
    if (!projectId) return;
    setPushing(true);
    setPushMsg(null);
    try {
      const r = await fetch("/api/pricing/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, amount: perLeg }),
      });
      const j = (await r.json()) as { ok?: boolean; error?: string };
      setPushMsg(j.ok ? { ok: true, text: "Queued — it applies on the next Auto-Pull." } : { ok: false, text: j.error ?? "Could not queue." });
    } catch {
      setPushMsg({ ok: false, text: "Could not queue — network error." });
    } finally {
      setPushing(false);
    }
  }

  const rTier = useMemo(() => readinessTier(subtotalNum), [subtotalNum]);
  const grandTotal = Math.round((q.total + (readiness ? rTier.fee : 0)) * 100) / 100;
  const ready = (rq?.resolved && !!rq.quote) || miles !== "" || subtotal !== "";

  const f = rq?.formula;
  const headerText = f
    ? `${money(f.baseFee)} base + tiered mileage (${f.mileageTiers.map((t) => `${money(t.ratePerMile)}/mi${t.uptoMile != null ? ` to ${t.uptoMile}` : "+"}`).join(", ")}) + ${Math.round(f.pct * 100)}% of the pre-discount subtotal (max ${money(f.pctCap)}), per leg.`
    : "Base + tiered mileage + a capped % of the pre-discount subtotal, per leg.";

  return (
    <main className="mx-auto max-w-2xl p-5 pb-24 md:p-8">
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <Calculator className="size-7" /> Delivery Pricing
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {headerText} The time-window upgrade (Standard / Premium / Exact) is a separate line item.
        </p>
      </header>

      <section className="surface space-y-4 rounded-2xl border border-white/5 p-5">
        <div className="relative space-y-1.5">
          <label htmlFor="project-search" className="flex items-center gap-1.5 text-sm font-medium">
            <FolderOpen className="size-4 text-primary" /> Find a project
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              id="project-search"
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                pickedLabelRef.current = "";
                setShowResults(true);
              }}
              onFocus={() => {
                if (results.length > 0) setShowResults(true);
              }}
              onBlur={() => setTimeout(() => setShowResults(false), 120)}
              onKeyDown={(e) => {
                if (!showResults || results.length === 0) return;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActiveIdx((i) => Math.min(i + 1, results.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActiveIdx((i) => Math.max(i - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const p = results[activeIdx];
                  if (p) pickProject(p);
                } else if (e.key === "Escape") {
                  setShowResults(false);
                }
              }}
              role="combobox"
              aria-expanded={showResults}
              aria-controls="project-results"
              aria-autocomplete="list"
              autoComplete="off"
              placeholder="search by project #, name, or customer…"
              className="w-full rounded-xl border border-white/10 bg-background py-2 pl-9 pr-9 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {searching && <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />}
          </div>
          {showResults && results.length > 0 && (
            <ul
              id="project-results"
              role="listbox"
              className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-xl border border-white/10 bg-background py-1 shadow-xl"
            >
              {results.map((p, i) => (
                <li key={p.id} role="option" aria-selected={i === activeIdx}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pickProject(p);
                    }}
                    onMouseEnter={() => setActiveIdx(i)}
                    className={`flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm ${i === activeIdx ? "bg-accent" : "hover:bg-accent/60"}`}
                  >
                    <span className="font-medium">{p.name}</span>
                    <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground tabular-nums">
                      <span className="font-mono">#{p.id}</span>
                      {p.clientName && p.clientName !== p.name && <span>· {p.clientName}</span>}
                      {p.subtotal != null && <span>· {money(p.subtotal)}</span>}
                      {p.eventDate && <span>· {p.eventDate}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {showResults && !searching && query.trim().length >= 2 && results.length === 0 && (
            <div className="absolute z-20 mt-1 w-full rounded-xl border border-white/10 bg-background px-3 py-2 text-xs text-muted-foreground shadow-xl">
              No matching projects.
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Type a project number, event name, or customer. On select it pulls the project&apos;s subtotal, location and event date. Location
            is city-level — refine the street address for exact miles.
          </p>
        </div>
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
              onClick={() => getMiles()}
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
            <label className="text-sm font-medium">Event date</label>
            <input
              type="date"
              value={eventDate}
              onChange={(e) => setEventDate(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <p className="text-xs text-muted-foreground">Used to find same-day signed jobs for route sharing.</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Miles (one way)</label>
            <input
              value={miles}
              onChange={(e) => setMiles(e.target.value.replace(/[^\d.]/g, ""))}
              inputMode="decimal"
              placeholder="auto from address, or type by hand"
              className="w-full rounded-xl border border-white/10 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Quote subtotal (before discount)</label>
          <input
            value={subtotal}
            onChange={(e) => {
              setSubtotal(e.target.value.replace(/[^\d.]/g, ""));
              setSubtotalInfo(null); // a hand-edited subtotal is neither live nor the stored pull value
            }}
            inputMode="decimal"
            placeholder="e.g. 2000"
            className="w-full rounded-xl border border-white/10 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {subtotalInfo && (
            <p className={`flex items-center gap-1 text-xs ${subtotalInfo.state === "live" ? "text-emerald-400" : subtotalInfo.state === "stored" ? "text-amber-300" : "text-muted-foreground"}`}>
              {subtotalInfo.state === "loading" && <Loader2 className="size-3 animate-spin" />}
              {subtotalInfo.state === "live" && <Check className="size-3" />}
              {subtotalInfo.text}
            </p>
          )}
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
            <span className="text-xs text-muted-foreground">Tiered by order value: under $500 $75 · $500–1,500 $150 · $1,500–3,000 $250 · $3,000+ $350+. Separate from delivery.</span>
          </span>
        </label>
      </section>

      {/* Result */}
      <section className="surface mt-5 rounded-2xl border border-white/5 p-5">
        {ready ? (
          <div className="space-y-4">
            {/* Pricing mode badge */}
            {pricingMode && (
              <div className="flex items-center justify-between gap-2">
                <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${MODE_BADGE[pricingMode].cls}`}>
                  <RouteIcon className="size-3.5" /> {MODE_BADGE[pricingMode].label}
                </span>
                {pricing && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
              </div>
            )}

            {q.dropOff && <LegRow title="Drop-off" leg={q.dropOff} />}
            {q.pickup && <LegRow title="Pickup" leg={q.pickup} />}
            <div className="flex items-center justify-between border-t border-white/10 pt-4">
              <span className="flex items-center gap-2 font-semibold">
                <Truck className="size-5 text-primary" /> Delivery {readiness ? "subtotal" : "total"}
              </span>
              <span className="text-xl font-bold tabular-nums">{money(q.total)}</span>
            </div>

            {/* Route internals — REP ONLY. The customer sees only the final price above. Never any cost/margin. */}
            {rq?.resolved && pricingMode === "ROUTE_OPTIMIZED" && rq.anchor && (
              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] p-3 text-xs">
                <div className="mb-1 font-semibold text-emerald-300">Route sharing (internal — not shown to the customer)</div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 tabular-nums text-muted-foreground">
                  <span>Shares route with</span>
                  <span className="text-right text-foreground">{rq.anchor.label}{rq.anchor.truckId ? ` · ${rq.anchor.truckId}` : ""}</span>
                  <span>Standard (warehouse) distance</span>
                  <span className="text-right">{rq.warehouseMiles} mi</span>
                  <span>Incremental (route) distance</span>
                  <span className="text-right text-foreground">{rq.incrementalMiles} mi</span>
                  <span>Distance saved</span>
                  <span className="text-right text-emerald-300">{rq.savingsMiles} mi</span>
                </div>
                {!rq.anchor.timingVerified && (
                  <p className="mt-1.5 text-amber-300">Timing unverified — that job isn&apos;t on a route yet, so its time window is unknown.</p>
                )}
              </div>
            )}

            {/* Why this mode — the deterministic explanation. */}
            {rq?.resolved && rq.reasons && rq.reasons.length > 0 && (
              <ul className="space-y-1 text-xs text-muted-foreground">
                {rq.reasons.map((r, i) => (
                  <li key={i} className="flex gap-1.5">
                    <span className="text-muted-foreground/60">•</span>
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            )}

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

            {projectId && (
              <div className="space-y-2 border-t border-white/10 pt-4">
                <button
                  onClick={pushToGoodshuffle}
                  disabled={pushing}
                  className="btn-hero inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium disabled:opacity-50"
                >
                  {pushing ? <Loader2 className="size-4 animate-spin" /> : pushMsg?.ok ? <Check className="size-4" /> : <Send className="size-4" />}
                  Push delivery fee to Goodshuffle
                </button>
                <p className="text-xs text-muted-foreground">
                  Overrides the Standard Delivery price on the selected project with {money(perLeg)} per leg (the {pricingMode ? MODE_BADGE[pricingMode].label.toLowerCase() : "current"}-mode fee). Applies on the next Auto-Pull.
                </p>
                {pushMsg && <p className={`text-xs ${pushMsg.ok ? "text-emerald-400" : "text-red-400"}`}>{pushMsg.text}</p>}
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Enter the address (and event date) or the miles, plus the subtotal, to see the price.</p>
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
        <span>subtotal fee {money(leg.subtotalFee)}{leg.subtotalCapped ? " (capped)" : ""}</span>
      </div>
    </div>
  );
}
