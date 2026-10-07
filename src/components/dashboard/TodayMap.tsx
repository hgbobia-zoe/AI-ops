"use client";

// Today's operations map — plots today's route stops (numbered pins + per-truck path) AND live truck
// positions from Ignition / Zonar (GPS TrackIt) on one SVG canvas. Stop coordinates come from the
// geocoder via /api/dispatch/today-map; truck coordinates are live GPS (server-side, key-gated). Keyless
// for the base map (no street tiles — that needs a maps key); it shows real geographic spread + stop
// order + where the trucks are. Anything without a real coordinate is omitted, never faked.

import { useEffect, useState } from "react";
import { Loader2, MapPin, Truck } from "lucide-react";

interface Pin { truckId: string; seq: number; lat: number; lng: number; label: string; kind: "delivery" | "pickup"; state: "done" | "active" | "waiting" }
interface TruckMarker { truckId: string; label: string; lat: number; lng: number; ts: string | null }
interface MapData { pins: Pin[]; trucks: TruckMarker[]; gpsConfigured: boolean }

const STATE_FILL: Record<Pin["state"], string> = { done: "var(--positive)", active: "#6aa8ff", waiting: "var(--bar-2)" };

function ago(ts: string | null): string {
  if (!ts) return "";
  const m = Math.round((Date.now() - Date.parse(ts)) / 60000);
  if (!Number.isFinite(m)) return "";
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

export function TodayMap(): React.JSX.Element {
  const [data, setData] = useState<MapData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/dispatch/today-map", { cache: "no-store" });
        if (!r.ok) throw new Error();
        const j = (await r.json()) as MapData;
        if (alive) setData(j);
      } catch {
        if (alive) setFailed(true);
      }
    };
    load();
    const id = setInterval(load, 60_000); // refresh live truck positions each minute
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (failed) return <Frame><span className="text-[11.5px] text-meta">Map unavailable.</span></Frame>;
  if (data === null) return <Frame><Loader2 className="size-4 animate-spin text-meta" /></Frame>;

  const { pins, trucks } = data;
  const all = [...pins.map((p) => ({ lat: p.lat, lng: p.lng })), ...trucks.map((t) => ({ lat: t.lat, lng: t.lng }))];
  if (all.length === 0) {
    return <Frame><span className="inline-flex items-center gap-1.5 text-[11.5px] text-meta"><MapPin className="size-3.5" /> {data.gpsConfigured ? "No stops or truck fixes to map." : "No mappable stops today."}</span></Frame>;
  }

  const W = 300, H = 150, pad = 18;
  let minLat = Math.min(...all.map((a) => a.lat)), maxLat = Math.max(...all.map((a) => a.lat));
  let minLng = Math.min(...all.map((a) => a.lng)), maxLng = Math.max(...all.map((a) => a.lng));
  if (maxLat - minLat < 0.01) { minLat -= 0.02; maxLat += 0.02; }
  if (maxLng - minLng < 0.01) { minLng -= 0.02; maxLng += 0.02; }
  const x = (lng: number) => pad + ((lng - minLng) / (maxLng - minLng)) * (W - 2 * pad);
  const y = (lat: number) => pad + ((maxLat - lat) / (maxLat - minLat)) * (H - 2 * pad);

  const byTruck = new Map<string, Pin[]>();
  for (const p of pins) { const a = byTruck.get(p.truckId) ?? []; a.push(p); byTruck.set(p.truckId, a); }

  return (
    <Frame>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" role="img" aria-label={`${pins.length} stops, ${trucks.length} trucks on today's routes`}>
        {[0.25, 0.5, 0.75].map((f) => (
          <g key={f}>
            <line x1={0} x2={W} y1={H * f} y2={H * f} stroke="var(--grid-rule)" strokeWidth={0.75} />
            <line x1={W * f} x2={W * f} y1={0} y2={H} stroke="var(--grid-rule)" strokeWidth={0.75} />
          </g>
        ))}
        {[...byTruck.values()].map((group, gi) => (
          <polyline key={gi} points={group.map((p) => `${x(p.lng)},${y(p.lat)}`).join(" ")} fill="none" stroke="var(--gold)" strokeOpacity={0.35} strokeWidth={1.25} strokeLinejoin="round" />
        ))}
        {pins.map((p, i) => (
          <g key={`p${i}`}>
            <circle cx={x(p.lng)} cy={y(p.lat)} r={7} fill={STATE_FILL[p.state]} stroke="var(--panel)" strokeWidth={1.5}>
              <title>{`${p.label} · ${p.kind}${p.state === "done" ? " · done" : p.state === "active" ? " · en route" : ""}`}</title>
            </circle>
            <text x={x(p.lng)} y={y(p.lat) + 2.6} textAnchor="middle" className="fill-[var(--background)] text-[8px] font-bold">{i + 1}</text>
          </g>
        ))}
        {/* live truck positions (Ignition / Zonar) */}
        {trucks.map((t, i) => (
          <g key={`t${i}`}>
            <rect x={x(t.lng) - 6} y={y(t.lat) - 6} width={12} height={12} rx={2.5} fill="var(--gold)" stroke="var(--background)" strokeWidth={1.5}>
              <title>{`${t.label} (live${t.ts ? ` · ${ago(t.ts)}` : ""})`}</title>
            </rect>
            <path d={`M ${x(t.lng) - 3} ${y(t.lat) - 1} h 4 v -2 h 1.5 l 1.5 2 v 3 h -7 z`} fill="var(--background)" />
          </g>
        ))}
      </svg>
      {trucks.length > 0 && (
        <div className="pointer-events-none absolute bottom-1 right-2 inline-flex items-center gap-1 text-[9px] text-meta">
          <Truck className="size-2.5 text-[var(--gold)]" /> live truck{trucks.length === 1 ? "" : "s"}
        </div>
      )}
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="relative flex h-[150px] items-center justify-center overflow-hidden rounded border border-border bg-[var(--panel)]">{children}</div>;
}
