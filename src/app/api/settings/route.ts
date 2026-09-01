// Settings API — powers the /admin page. GET returns the current (merged) settings so
// the form can populate; POST saves an edited set. The write is gated by an admin code
// (ADMIN_PIN, falling back to NEXT_PUBLIC_ADMIN_PIN, default "0000"). This is a soft
// gate for an internal tool — real auth comes with productization. No secrets (SMS /
// Slack keys) live in these settings, so GET is safe to serve to the internal board.

import { NextResponse } from "next/server";
import { getSettings, saveSettings, type AppSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

function adminPin(): string {
  return process.env.ADMIN_PIN || process.env.NEXT_PUBLIC_ADMIN_PIN || "0000";
}

export function GET(): NextResponse {
  return NextResponse.json(getSettings());
}

// Coerce an arbitrary body into a valid AppSettings by overlaying only known, well-typed
// fields onto the current settings. Anything missing/malformed keeps its current value.
function coerce(body: unknown, current: AppSettings): AppSettings {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown, fb: string) => (typeof v === "string" ? v : fb);
  const strMap = (v: unknown, fb: Record<string, string>) => {
    if (!v || typeof v !== "object") return fb;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string" && val.trim()) out[k] = val.trim();
    }
    return out;
  };
  const numMap = (v: unknown, fb: Record<string, number>) => {
    if (!v || typeof v !== "object") return fb;
    const out: Record<string, number> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const n = typeof val === "number" ? val : Number(val);
      if (Number.isFinite(n)) out[k] = n;
    }
    return out;
  };
  const t = (b.templates ?? {}) as Record<string, unknown>;
  return {
    companyName: str(b.companyName, current.companyName),
    timezone: str(b.timezone, current.timezone),
    notifyPhone: str(b.notifyPhone, current.notifyPhone),
    ignitionUrl: str(b.ignitionUrl, current.ignitionUrl),
    ignitionEtaLinks: strMap(b.ignitionEtaLinks, current.ignitionEtaLinks),
    ignitionUnits: numMap(b.ignitionUnits, current.ignitionUnits),
    templates: {
      onWay: str(t.onWay, current.templates.onWay),
      arrived: str(t.arrived, current.templates.arrived),
      coordinatorOnWay: str(t.coordinatorOnWay, current.templates.coordinatorOnWay),
      coordinatorArrived: str(t.coordinatorArrived, current.templates.coordinatorArrived),
      onWayPickup: str(t.onWayPickup, current.templates.onWayPickup),
      arrivedPickup: str(t.arrivedPickup, current.templates.arrivedPickup),
      coordinatorOnWayPickup: str(t.coordinatorOnWayPickup, current.templates.coordinatorOnWayPickup),
      coordinatorArrivedPickup: str(t.coordinatorArrivedPickup, current.templates.coordinatorArrivedPickup),
    },
    smsProvider: str(b.smsProvider, current.smsProvider),
    gpsProvider: str(b.gpsProvider, current.gpsProvider),
    gpsVehicleIds: strMap(b.gpsVehicleIds, current.gpsVehicleIds),
  };
}

export async function POST(req: Request): Promise<NextResponse> {
  if ((req.headers.get("x-admin-pin") || "") !== adminPin()) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const next = coerce(body, getSettings());
  saveSettings(next);
  return NextResponse.json({ ok: true, settings: next });
}
