// Pluggable integration providers — the "switch your GPS / phone system" module.
//
// Two provider kinds, each with a small interface so the rest of the app is provider-
// agnostic: SMS (OpenPhone / RingCentral / Dialpad) and GPS telematics (Zonar-on-tablet
// / Samsara / Motive). The active provider is chosen in /admin; its credentials live in
// the secrets store. Every call is defensive: unconfigured → `skipped`, never throws.
//
// Server-only (uses fetch + the secrets store). API request shapes follow each vendor's
// public REST API; verify against live credentials when first connecting one.

import { getProviderConfig } from "@/lib/secrets";

export interface ProviderField {
  key: string;
  label: string;
  secret: boolean; // secret fields are masked (never returned to the client in plaintext)
  placeholder?: string;
  help?: string;
}

export interface SmsResult {
  ok: boolean;
  skipped?: boolean;
  providerMsgId?: string;
  error?: string;
}
export interface TestResult {
  ok: boolean;
  error?: string;
}
export interface GpsLocation {
  ok: boolean;
  skipped?: boolean;
  lat?: number;
  lng?: number;
  speedMph?: number;
  ts?: string;
  error?: string;
}

export type ProviderKind = "sms" | "gps";

export interface SmsProviderDef {
  id: string;
  name: string;
  fields: ProviderField[];
  send(to: string, body: string, cfg: Record<string, string>): Promise<SmsResult>;
  test(cfg: Record<string, string>): Promise<TestResult>;
}

export interface GpsProviderDef {
  id: string;
  name: string;
  /** false = credentials/location handled on the tablet (Zonar), not server-side. */
  serverSide: boolean;
  fields: ProviderField[];
  getLocation(vehicleId: string, cfg: Record<string, string>): Promise<GpsLocation>;
  test(cfg: Record<string, string>): Promise<TestResult>;
}

// ── fetch with a timeout, returning parsed JSON + status ──────────────────────
async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs = 12000,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown>; error?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    return { ok: false, status: 0, json: {}, error: String(err) };
  } finally {
    clearTimeout(t);
  }
}

function need(cfg: Record<string, string>, keys: string[]): string | null {
  const missing = keys.filter((k) => !cfg[k]);
  return missing.length ? `not configured (missing ${missing.join(", ")})` : null;
}

// ── SMS providers ─────────────────────────────────────────────────────────────

const openphone: SmsProviderDef = {
  id: "openphone",
  name: "OpenPhone",
  fields: [
    { key: "apiKey", label: "API key", secret: true },
    { key: "fromNumber", label: "From number (E.164)", secret: false, placeholder: "+13012915296" },
  ],
  async send(to, body, cfg) {
    const miss = need(cfg, ["apiKey", "fromNumber"]);
    if (miss) return { ok: false, skipped: true, error: miss };
    const r = await fetchJson("https://api.openphone.com/v1/messages", {
      method: "POST",
      headers: { authorization: cfg.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ from: cfg.fromNumber, to: [to], content: body }),
    });
    if (r.error) return { ok: false, error: r.error };
    if (!r.ok) return { ok: false, error: `openphone ${r.status}: ${(r.json.message as string) ?? ""}`.trim() };
    const data = r.json.data as { id?: string } | undefined;
    return { ok: true, providerMsgId: data?.id ?? (r.json.id as string) };
  },
  async test(cfg) {
    if (!cfg.apiKey) return { ok: false, error: "no API key" };
    const r = await fetchJson("https://api.openphone.com/v1/phone-numbers", {
      headers: { authorization: cfg.apiKey },
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error ?? `HTTP ${r.status}` };
  },
};

async function ringcentralToken(
  cfg: Record<string, string>,
): Promise<{ token?: string; server: string; error?: string }> {
  const server = cfg.serverUrl || "https://platform.ringcentral.com";
  const miss = need(cfg, ["clientId", "clientSecret", "jwt"]);
  if (miss) return { server, error: miss };
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const r = await fetchJson(`${server}/restapi/oauth/token`, {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: cfg.jwt,
    }).toString(),
  });
  if (r.error) return { server, error: r.error };
  if (!r.ok) {
    return { server, error: `ringcentral auth ${r.status}: ${(r.json.error_description as string) ?? (r.json.error as string) ?? ""}`.trim() };
  }
  return { server, token: r.json.access_token as string };
}

const ringcentral: SmsProviderDef = {
  id: "ringcentral",
  name: "RingCentral",
  fields: [
    { key: "serverUrl", label: "Server URL", secret: false, placeholder: "https://platform.ringcentral.com", help: "Sandbox: https://platform.devtest.ringcentral.com" },
    { key: "clientId", label: "Client ID", secret: true },
    { key: "clientSecret", label: "Client secret", secret: true },
    { key: "jwt", label: "JWT credential", secret: true, help: "From the RingCentral app's Auth → JWT." },
    { key: "fromNumber", label: "From number (E.164)", secret: false, placeholder: "+13012915296" },
  ],
  async send(to, body, cfg) {
    const miss = need(cfg, ["clientId", "clientSecret", "jwt", "fromNumber"]);
    if (miss) return { ok: false, skipped: true, error: miss };
    const auth = await ringcentralToken(cfg);
    if (!auth.token) return { ok: false, error: auth.error ?? "ringcentral auth failed" };
    const r = await fetchJson(`${auth.server}/restapi/v1.0/account/~/extension/~/sms`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
      body: JSON.stringify({ from: { phoneNumber: cfg.fromNumber }, to: [{ phoneNumber: to }], text: body }),
    });
    if (r.error) return { ok: false, error: r.error };
    if (!r.ok) {
      const msg = (r.json.message as string) ?? ((r.json.errors as { message?: string }[])?.[0]?.message ?? "");
      return { ok: false, error: `ringcentral ${r.status}: ${msg}`.trim() };
    }
    return { ok: true, providerMsgId: r.json.id as string };
  },
  async test(cfg) {
    const auth = await ringcentralToken(cfg);
    return auth.token ? { ok: true } : { ok: false, error: auth.error ?? "auth failed" };
  },
};

const dialpad: SmsProviderDef = {
  id: "dialpad",
  name: "Dialpad",
  fields: [
    { key: "apiKey", label: "API key", secret: true },
    { key: "fromNumber", label: "From number (E.164)", secret: false, placeholder: "+13012915296" },
    { key: "baseUrl", label: "Base URL", secret: false, placeholder: "https://dialpad.com" },
  ],
  async send(to, body, cfg) {
    const miss = need(cfg, ["apiKey", "fromNumber"]);
    if (miss) return { ok: false, skipped: true, error: miss };
    const base = cfg.baseUrl || "https://dialpad.com";
    const r = await fetchJson(`${base}/api/v2/sms`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from_number: cfg.fromNumber, to_numbers: [to], text: body, infer_country_code: false }),
    });
    if (r.error) return { ok: false, error: r.error };
    if (!r.ok) return { ok: false, error: `dialpad ${r.status}: ${(r.json.message as string) ?? ""}`.trim() };
    return { ok: true, providerMsgId: r.json.id as string };
  },
  async test(cfg) {
    if (!cfg.apiKey) return { ok: false, error: "no API key" };
    const base = cfg.baseUrl || "https://dialpad.com";
    const r = await fetchJson(`${base}/api/v2/users?limit=1`, {
      headers: { authorization: `Bearer ${cfg.apiKey}` },
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error ?? `HTTP ${r.status}` };
  },
};

export const SMS_PROVIDERS: SmsProviderDef[] = [openphone, ringcentral, dialpad];

// ── GPS providers ─────────────────────────────────────────────────────────────

// Zonar/Ignition: the live session + ETA-link mint live on the TABLET (native), so
// there's nothing to configure or fetch server-side here. Kept as the default.
const zonar: GpsProviderDef = {
  id: "zonar",
  name: "Zonar (Ignition, on tablet)",
  serverSide: false,
  fields: [],
  async getLocation() {
    return { ok: false, skipped: true, error: "handled on the tablet's Ignition session" };
  },
  async test() {
    return { ok: true };
  },
};

const samsara: GpsProviderDef = {
  id: "samsara",
  name: "Samsara",
  serverSide: true,
  fields: [
    { key: "apiToken", label: "API token", secret: true, help: "Samsara → Settings → API tokens." },
    { key: "baseUrl", label: "Base URL", secret: false, placeholder: "https://api.samsara.com" },
  ],
  async getLocation(vehicleId, cfg) {
    const miss = need(cfg, ["apiToken"]);
    if (miss) return { ok: false, skipped: true, error: miss };
    if (!vehicleId) return { ok: false, error: "no vehicle id" };
    const base = cfg.baseUrl || "https://api.samsara.com";
    const r = await fetchJson(
      `${base}/fleet/vehicles/stats?types=gps&vehicleIds=${encodeURIComponent(vehicleId)}`,
      { headers: { authorization: `Bearer ${cfg.apiToken}` } },
    );
    if (r.error) return { ok: false, error: r.error };
    if (!r.ok) return { ok: false, error: `samsara ${r.status}` };
    const row = (r.json.data as Array<{ gps?: { latitude?: number; longitude?: number; speedMilesPerHour?: number; time?: string } }>)?.[0];
    const gps = row?.gps;
    if (!gps || gps.latitude == null) return { ok: false, error: "no gps in response" };
    return { ok: true, lat: gps.latitude, lng: gps.longitude, speedMph: gps.speedMilesPerHour, ts: gps.time };
  },
  async test(cfg) {
    if (!cfg.apiToken) return { ok: false, error: "no API token" };
    const base = cfg.baseUrl || "https://api.samsara.com";
    const r = await fetchJson(`${base}/fleet/vehicles?limit=1`, {
      headers: { authorization: `Bearer ${cfg.apiToken}` },
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error ?? `HTTP ${r.status}` };
  },
};

const motive: GpsProviderDef = {
  id: "motive",
  name: "Motive (KeepTruckin)",
  serverSide: true,
  fields: [
    { key: "apiKey", label: "API key", secret: true, help: "Motive → Admin → API keys." },
    { key: "baseUrl", label: "Base URL", secret: false, placeholder: "https://api.gomotive.com" },
  ],
  async getLocation(vehicleId, cfg) {
    const miss = need(cfg, ["apiKey"]);
    if (miss) return { ok: false, skipped: true, error: miss };
    if (!vehicleId) return { ok: false, error: "no vehicle id" };
    const base = cfg.baseUrl || "https://api.gomotive.com";
    const r = await fetchJson(
      `${base}/v1/vehicle_locations?vehicle_ids=${encodeURIComponent(vehicleId)}&per_page=1`,
      { headers: { "x-api-key": cfg.apiKey } },
    );
    if (r.error) return { ok: false, error: r.error };
    if (!r.ok) return { ok: false, error: `motive ${r.status}` };
    const row = (r.json.vehicles as Array<{ vehicle?: { current_location?: { lat?: number; lon?: number; speed?: number; located_at?: string } } }>)?.[0];
    const loc = row?.vehicle?.current_location;
    if (!loc || loc.lat == null) return { ok: false, error: "no location in response" };
    return { ok: true, lat: loc.lat, lng: loc.lon, speedMph: loc.speed, ts: loc.located_at };
  },
  async test(cfg) {
    if (!cfg.apiKey) return { ok: false, error: "no API key" };
    const base = cfg.baseUrl || "https://api.gomotive.com";
    const r = await fetchJson(`${base}/v1/users?per_page=1`, { headers: { "x-api-key": cfg.apiKey } });
    return r.ok ? { ok: true } : { ok: false, error: r.error ?? `HTTP ${r.status}` };
  },
};

export const GPS_PROVIDERS: GpsProviderDef[] = [zonar, samsara, motive];

// ── Registry helpers ──────────────────────────────────────────────────────────

export function smsProviderById(id: string): SmsProviderDef {
  return SMS_PROVIDERS.find((p) => p.id === id) ?? openphone;
}
export function gpsProviderById(id: string): GpsProviderDef {
  return GPS_PROVIDERS.find((p) => p.id === id) ?? zonar;
}

/** Load a provider's stored credentials from the secrets store. */
export function loadSmsConfig(id: string): Record<string, string> {
  return getProviderConfig(id, smsProviderById(id).fields.map((f) => f.key));
}
export function loadGpsConfig(id: string): Record<string, string> {
  return getProviderConfig(id, gpsProviderById(id).fields.map((f) => f.key));
}

/** Client-safe descriptor (no functions) for rendering the admin form. */
export interface ProviderMeta {
  id: string;
  name: string;
  kind: ProviderKind;
  serverSide?: boolean;
  fields: ProviderField[];
}
export function providerCatalog(): { sms: ProviderMeta[]; gps: ProviderMeta[] } {
  return {
    sms: SMS_PROVIDERS.map((p) => ({ id: p.id, name: p.name, kind: "sms", fields: p.fields })),
    gps: GPS_PROVIDERS.map((p) => ({ id: p.id, name: p.name, kind: "gps", serverSide: p.serverSide, fields: p.fields })),
  };
}
