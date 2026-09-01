"use client";

// The /admin "Integrations" section: switch the active GPS telematics and phone (SMS)
// provider, enter each one's credentials, and test the connection. Provider selection is
// part of the main settings (saved with "Save changes"); credentials are saved here via
// the integrations API (secret values are write-only — never sent back to the browser).

import { useEffect, useMemo, useState } from "react";
import { Loader2, Save, Radio, Phone, PlugZap, Check, X } from "lucide-react";

interface Field {
  key: string;
  label: string;
  secret: boolean;
  placeholder?: string;
  help?: string;
}
interface ProviderMeta {
  id: string;
  name: string;
  kind: "sms" | "gps";
  serverSide?: boolean;
  fields: Field[];
}
type FieldStatus = { set?: boolean; value?: string };
type Status = Record<string, Record<string, FieldStatus>>;
type Draft = Record<string, Record<string, string>>;

export function IntegrationsSettings({
  smsProvider,
  gpsProvider,
  gpsVehicleIds,
  trucks,
  pin,
  onChange,
}: {
  smsProvider: string;
  gpsProvider: string;
  gpsVehicleIds: Record<string, string>;
  trucks: string[];
  pin: string;
  onChange: (patch: Partial<{ smsProvider: string; gpsProvider: string; gpsVehicleIds: Record<string, string> }>) => void;
}) {
  const [catalog, setCatalog] = useState<{ sms: ProviderMeta[]; gps: ProviderMeta[] } | null>(null);
  const [status, setStatus] = useState<Status>({});
  const [draft, setDraft] = useState<Draft>({});

  useEffect(() => {
    fetch("/api/integrations")
      .then((r) => r.json())
      .then((d: { catalog: { sms: ProviderMeta[]; gps: ProviderMeta[] }; status: Status }) => {
        setCatalog(d.catalog);
        setStatus(d.status);
        // Seed the draft: non-secret fields from stored values, secret fields blank.
        const next: Draft = {};
        for (const p of [...d.catalog.sms, ...d.catalog.gps]) {
          next[p.id] = {};
          for (const f of p.fields) next[p.id][f.key] = f.secret ? "" : d.status[p.id]?.[f.key]?.value ?? "";
        }
        setDraft(next);
      })
      .catch(() => {});
  }, []);

  const gpsDef = useMemo(() => catalog?.gps.find((p) => p.id === gpsProvider), [catalog, gpsProvider]);
  const smsDef = useMemo(() => catalog?.sms.find((p) => p.id === smsProvider), [catalog, smsProvider]);

  if (!catalog) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading integrations…
      </div>
    );
  }

  const setField = (pid: string, key: string, v: string) =>
    setDraft((d) => ({ ...d, [pid]: { ...d[pid], [key]: v } }));

  return (
    <div className="space-y-8">
      {/* GPS */}
      <ProviderBlock
        kindIcon={<Radio className="size-4" />}
        kindLabel="GPS / telematics"
        options={catalog.gps}
        selectedId={gpsProvider}
        onSelect={(id) => onChange({ gpsProvider: id })}
        def={gpsDef}
        draft={draft}
        status={status}
        setField={setField}
        pin={pin}
        onSaved={setStatus}
        kind="gps"
      >
        {gpsDef?.serverSide && (
          <div className="space-y-2">
            <div className="text-sm font-medium">Per-truck vehicle id</div>
            <p className="text-xs text-muted-foreground">
              Each truck&apos;s vehicle id in {gpsDef.name}. Used to fetch live location for the
              customer tracking link.
            </p>
            {trucks.map((t) => (
              <div key={t} className="grid grid-cols-[5rem_1fr] items-center gap-2">
                <span className="text-sm font-medium tabular-nums">{t}</span>
                <input
                  type="text"
                  value={gpsVehicleIds[t] ?? ""}
                  placeholder="vehicle id"
                  onChange={(e) => onChange({ gpsVehicleIds: { ...gpsVehicleIds, [t]: e.target.value } })}
                  className="w-full rounded-xl border border-white/10 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
            ))}
          </div>
        )}
      </ProviderBlock>

      {/* SMS */}
      <ProviderBlock
        kindIcon={<Phone className="size-4" />}
        kindLabel="Phone / SMS"
        options={catalog.sms}
        selectedId={smsProvider}
        onSelect={(id) => onChange({ smsProvider: id })}
        def={smsDef}
        draft={draft}
        status={status}
        setField={setField}
        pin={pin}
        onSaved={setStatus}
        kind="sms"
      />

      <p className="text-xs text-muted-foreground">
        Provider choice saves with <span className="font-medium text-foreground">Save changes</span> at
        the top; credentials save with the <span className="font-medium text-foreground">Save credentials</span>{" "}
        button in each block. Secret values are write-only — they&apos;re never shown back here.
      </p>
    </div>
  );
}

function ProviderBlock({
  kindIcon,
  kindLabel,
  options,
  selectedId,
  onSelect,
  def,
  draft,
  status,
  setField,
  pin,
  onSaved,
  kind,
  children,
}: {
  kindIcon: React.ReactNode;
  kindLabel: string;
  options: ProviderMeta[];
  selectedId: string;
  onSelect: (id: string) => void;
  def?: ProviderMeta;
  draft: Draft;
  status: Status;
  setField: (pid: string, key: string, v: string) => void;
  pin: string;
  onSaved: (s: Status) => void;
  kind: "sms" | "gps";
  children?: React.ReactNode;
}) {
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  async function saveCreds() {
    if (!def) return;
    setSaving(true);
    setResult(null);
    try {
      const r = await fetch("/api/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-pin": pin },
        body: JSON.stringify({ provider: def.id, values: draft[def.id] ?? {} }),
      });
      const d = (await r.json()) as { status?: Status; error?: string };
      if (!r.ok) setResult({ ok: false, msg: d.error === "unauthorized" ? "Wrong admin code" : `Save failed (${r.status})` });
      else {
        if (d.status) onSaved(d.status);
        setResult({ ok: true, msg: "Credentials saved" });
      }
    } catch {
      setResult({ ok: false, msg: "Network error" });
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    if (!def) return;
    setTesting(true);
    setResult(null);
    try {
      const r = await fetch("/api/integrations/test", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-pin": pin },
        body: JSON.stringify({ kind, provider: def.id }),
      });
      const d = (await r.json()) as { ok?: boolean; error?: string };
      setResult(d.ok ? { ok: true, msg: "Connection OK" } : { ok: false, msg: d.error || "Test failed" });
    } catch {
      setResult({ ok: false, msg: "Network error" });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        {kindIcon} {kindLabel}
      </div>
      <select
        value={selectedId}
        onChange={(e) => onSelect(e.target.value)}
        className="w-full rounded-xl border border-white/10 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {options.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>

      {def && def.fields.length > 0 && (
        <div className="space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
          {def.fields.map((f) => {
            const st = status[def.id]?.[f.key];
            const secretSet = f.secret && st?.set;
            return (
              <div key={f.key} className="space-y-1">
                <label className="text-xs font-medium">
                  {f.label}
                  {secretSet && <span className="ml-2 text-[10px] text-emerald-400">saved</span>}
                </label>
                {f.help && <p className="text-[11px] text-muted-foreground">{f.help}</p>}
                <input
                  type={f.secret ? "password" : "text"}
                  value={draft[def.id]?.[f.key] ?? ""}
                  placeholder={f.secret ? (secretSet ? "•••••••• (leave blank to keep)" : f.placeholder ?? "") : f.placeholder ?? ""}
                  onChange={(e) => setField(def.id, f.key, e.target.value)}
                  autoComplete="off"
                  className="w-full rounded-lg border border-white/10 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
            );
          })}
        </div>
      )}

      {children}

      {def && (def.fields.length > 0 || def.serverSide) && (
        <div className="flex flex-wrap items-center gap-2">
          {def.fields.length > 0 && (
            <button
              type="button"
              onClick={saveCreds}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-3.5 py-2 text-sm hover:bg-accent disabled:opacity-50"
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              Save credentials
            </button>
          )}
          <button
            type="button"
            onClick={test}
            disabled={testing}
            className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-3.5 py-2 text-sm hover:bg-accent disabled:opacity-50"
          >
            {testing ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
            Test connection
          </button>
          {result && (
            <span
              className={`inline-flex items-center gap-1 text-xs font-medium ${
                result.ok ? "text-emerald-400" : "text-red-400"
              }`}
            >
              {result.ok ? <Check className="size-3.5" /> : <X className="size-3.5" />}
              {result.msg}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
