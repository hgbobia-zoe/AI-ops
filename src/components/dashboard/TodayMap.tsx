"use client";

// Today's operations map — a real street map (Leaflet + CARTO dark basemap, OpenStreetMap data, no API
// key) showing today's route stops (numbered pins + per-truck path) and LIVE truck positions from
// Ignition / Zonar (GPS TrackIt). Stop coords come from the geocoder; truck coords are live GPS — both via
// /api/dispatch/today-map. Leaflet is loaded client-only (dynamic import) so it never runs during SSR.
// Nothing without a real coordinate is drawn; no coords at all → an honest empty state.

import { useEffect, useRef, useState } from "react";
import type * as LType from "leaflet";
import "leaflet/dist/leaflet.css";
import { Loader2, MapPin } from "lucide-react";

interface Pin { truckId: string; seq: number; lat: number; lng: number; label: string; kind: "delivery" | "pickup"; state: "done" | "active" | "waiting" }
interface TruckMarker { truckId: string; label: string; lat: number; lng: number; ts: string | null }
interface MapData { pins: Pin[]; trucks: TruckMarker[]; gpsConfigured: boolean }

const STATE_FILL: Record<Pin["state"], string> = { done: "#86c3a2", active: "#6aa8ff", waiting: "#595d6c" };
const GOLD = "#e3b24a";
const H = 190;

function stopIcon(L: typeof LType, n: number, fill: string): LType.DivIcon {
  return L.divIcon({
    className: "",
    html: `<div style="width:20px;height:20px;border-radius:50%;background:${fill};border:2px solid #181a28;color:#161826;font:700 10px/16px ui-sans-serif,system-ui;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,.5)">${n}</div>`,
    iconSize: [20, 20], iconAnchor: [10, 10],
  });
}
function truckIcon(L: typeof LType, label: string): LType.DivIcon {
  return L.divIcon({
    className: "",
    html: `<div title="${label}" style="width:18px;height:18px;border-radius:4px;background:${GOLD};border:2px solid #161826;box-shadow:0 1px 4px rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center"><svg width="10" height="10" viewBox="0 0 24 24" fill="#161826"><path d="M3 6a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v3h3l3 3v4a1 1 0 0 1-1 1h-1a2.5 2.5 0 0 1-5 0H9a2.5 2.5 0 0 1-5 0H4a1 1 0 0 1-1-1V6Z"/></svg></div>`,
    iconSize: [18, 18], iconAnchor: [9, 9],
  });
}

export function TodayMap(): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LType.Map | null>(null);
  const liveRef = useRef<LType.LayerGroup | null>(null); // truck + route layer, redrawn on refresh
  const LRef = useRef<typeof LType | null>(null);
  const firstFit = useRef(true);
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "failed">("loading");
  const [gpsConfigured, setGpsConfigured] = useState(false);

  useEffect(() => {
    let alive = true;

    async function draw(L: typeof LType, data: MapData): Promise<void> {
      const { pins, trucks } = data;
      setGpsConfigured(data.gpsConfigured);
      const all = [...pins, ...trucks];
      if (all.length === 0) { setStatus("empty"); return; }

      // Init the map + dark basemap once.
      if (!mapRef.current && ref.current) {
        const map = L.map(ref.current, { zoomControl: false, attributionControl: true, scrollWheelZoom: false });
        // OpenStreetMap standard tiles — genuinely free and keyless. They are light, so the
        // `.map-dark-tiles` CSS filter inverts them into a dark basemap that matches Nocturne (the filter
        // hits only the tile imagery, not the markers/labels). Low-volume internal use per the OSM policy.
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19, className: "map-dark-tiles",
          attribution: '&copy; OpenStreetMap contributors',
        }).addTo(map);
        L.control.zoom({ position: "topright" }).addTo(map);
        mapRef.current = map;
        liveRef.current = L.layerGroup().addTo(map);
      }
      const map = mapRef.current!;

      // Stops: draw once (states rarely change within a session; redrawn on full reload). Route path per truck.
      const stopsLayer = L.layerGroup().addTo(map);
      const byTruck = new Map<string, Pin[]>();
      for (const p of pins) { const a = byTruck.get(p.truckId) ?? []; a.push(p); byTruck.set(p.truckId, a); }
      for (const group of byTruck.values()) {
        if (group.length > 1) L.polyline(group.map((p) => [p.lat, p.lng] as [number, number]), { color: GOLD, opacity: 0.4, weight: 2 }).addTo(stopsLayer);
      }
      pins.forEach((p, i) => {
        L.marker([p.lat, p.lng], { icon: stopIcon(L, i + 1, STATE_FILL[p.state]) })
          .bindTooltip(`${p.label} · ${p.kind}`, { direction: "top" }).addTo(stopsLayer);
      });

      // Trucks: live layer (replaced on each refresh).
      drawTrucks(L, trucks);

      if (firstFit.current) {
        const bounds = L.latLngBounds(all.map((a) => [a.lat, a.lng] as [number, number]));
        map.fitBounds(bounds.pad(0.25), { maxZoom: 13 });
        firstFit.current = false;
      }
      // Leaflet needs a size recalc after the container becomes visible.
      setTimeout(() => map.invalidateSize(), 60);
      setStatus("ready");
    }

    function drawTrucks(L: typeof LType, trucks: TruckMarker[]): void {
      const layer = liveRef.current;
      if (!layer) return;
      layer.clearLayers();
      for (const t of trucks) {
        L.marker([t.lat, t.lng], { icon: truckIcon(L, t.label), zIndexOffset: 1000 })
          .bindTooltip(`${t.label} (live)`, { direction: "top" }).addTo(layer);
      }
    }

    async function load(initial: boolean): Promise<void> {
      try {
        const r = await fetch("/api/dispatch/today-map", { cache: "no-store" });
        if (!r.ok) throw new Error();
        const data = (await r.json()) as MapData;
        if (!alive) return;
        if (!LRef.current) {
          const mod = await import("leaflet");
          LRef.current = ((mod as unknown as { default?: typeof LType }).default ?? (mod as unknown as typeof LType));
        }
        const L = LRef.current;
        if (!alive || !L) return;
        if (initial || !mapRef.current) await draw(L, data);
        else drawTrucks(L, data.trucks); // refresh just the live truck layer
      } catch {
        if (alive && initial) setStatus("failed");
      }
    }

    load(true);
    const id = setInterval(() => load(false), 120_000); // refresh live truck positions every 2 min
    return () => {
      alive = false;
      clearInterval(id);
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  return (
    <div className="relative overflow-hidden rounded border border-border" style={{ height: H }}>
      <div ref={ref} className="h-full w-full" style={{ background: "var(--panel)" }} />
      {status !== "ready" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[var(--panel)]">
          {status === "loading" && <Loader2 className="size-4 animate-spin text-meta" />}
          {status === "failed" && <span className="text-[11.5px] text-meta">Map unavailable.</span>}
          {status === "empty" && <span className="inline-flex items-center gap-1.5 text-[11.5px] text-meta"><MapPin className="size-3.5" /> {gpsConfigured ? "No stops or truck fixes to map." : "No mappable stops today."}</span>}
        </div>
      )}
    </div>
  );
}
