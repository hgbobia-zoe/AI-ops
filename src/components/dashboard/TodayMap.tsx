"use client";

// Today's operations map — plots today's route stops as numbered pins with the route path per truck.
// Keyless: coordinates come from the geocoder (Nominatim, or Google when GOOGLE_MAPS_API_KEY is set) via
// /api/dispatch/today-map, normalized into an SVG viewBox. It shows the real geographic spread + stop
// order; it is not a street-tile map (that needs a maps key). A stop that can't be geocoded is omitted.

import { useEffect, useState } from "react";
import { Loader2, MapPin } from "lucide-react";

interface Pin { truckId: string; seq: number; lat: number; lng: number; label: string; kind: "delivery" | "pickup"; state: "done" | "active" | "waiting" }

const STATE_FILL: Record<Pin["state"], string> = { done: "var(--positive)", active: "#6aa8ff", waiting: "var(--bar-2)" };

export function TodayMap(): React.JSX.Element {
  const [pins, setPins] = useState<Pin[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/dispatch/today-map", { cache: "no-store" });
        if (!r.ok) throw new Error();
        const j = (await r.json()) as { pins: Pin[] };
        if (alive) setPins(j.pins);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => { alive = false; };
  }, []);

  if (failed) return <Frame><span className="text-[11.5px] text-meta">Map unavailable.</span></Frame>;
  if (pins === null) return <Frame><Loader2 className="size-4 animate-spin text-meta" /></Frame>;
  if (pins.length === 0) return <Frame><span className="inline-flex items-center gap-1.5 text-[11.5px] text-meta"><MapPin className="size-3.5" /> No mappable stops today.</span></Frame>;

  // Normalize lat/lng into the viewBox (north up). Pad a degenerate (single-point) box.
  const W = 300, H = 150, pad = 18;
  const lats = pins.map((p) => p.lat), lngs = pins.map((p) => p.lng);
  let minLat = Math.min(...lats), maxLat = Math.max(...lats), minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  if (maxLat - minLat < 0.01) { minLat -= 0.02; maxLat += 0.02; }
  if (maxLng - minLng < 0.01) { minLng -= 0.02; maxLng += 0.02; }
  const x = (lng: number) => pad + ((lng - minLng) / (maxLng - minLng)) * (W - 2 * pad);
  const y = (lat: number) => pad + ((maxLat - lat) / (maxLat - minLat)) * (H - 2 * pad);

  // Route paths per truck (stops in sequence order).
  const byTruck = new Map<string, Pin[]>();
  for (const p of pins) { const a = byTruck.get(p.truckId) ?? []; a.push(p); byTruck.set(p.truckId, a); }

  return (
    <Frame>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" role="img" aria-label={`${pins.length} stops on today's routes`}>
        {/* faint grid backdrop */}
        {[0.25, 0.5, 0.75].map((f) => (
          <g key={f}>
            <line x1={0} x2={W} y1={H * f} y2={H * f} stroke="var(--grid-rule)" strokeWidth={0.75} />
            <line x1={W * f} x2={W * f} y1={0} y2={H} stroke="var(--grid-rule)" strokeWidth={0.75} />
          </g>
        ))}
        {/* route path per truck */}
        {[...byTruck.values()].map((group, gi) => (
          <polyline key={gi} points={group.map((p) => `${x(p.lng)},${y(p.lat)}`).join(" ")} fill="none" stroke="var(--gold)" strokeOpacity={0.35} strokeWidth={1.25} strokeLinejoin="round" />
        ))}
        {/* pins */}
        {pins.map((p, i) => (
          <g key={i}>
            <circle cx={x(p.lng)} cy={y(p.lat)} r={7} fill={STATE_FILL[p.state]} stroke="var(--panel)" strokeWidth={1.5}>
              <title>{`${p.label} · ${p.kind}${p.state === "done" ? " · done" : p.state === "active" ? " · en route" : ""}`}</title>
            </circle>
            <text x={x(p.lng)} y={y(p.lat) + 2.6} textAnchor="middle" className="fill-[var(--background)] text-[8px] font-bold">{i + 1}</text>
          </g>
        ))}
      </svg>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex h-[150px] items-center justify-center overflow-hidden rounded border border-border bg-[var(--panel)]">{children}</div>;
}
