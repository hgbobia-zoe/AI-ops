"use client";

// Team-facing settings — "customize outside of code". Edit message templates, the
// Ignition link, per-truck ETA links / unit ids, company name and timezone, then Save.
// Soft-gated by a 4-digit admin code (NEXT_PUBLIC_ADMIN_PIN, default 0000); the write
// is verified server-side. No secrets live here.

import { useEffect, useMemo, useState } from "react";
import { Loader2, Save, Check, ShieldCheck, MessageSquareText, Radio, Building2, KeyRound, LogIn, PlugZap } from "lucide-react";
import { isKiosk, switchGoodshuffleLoginViaKiosk, switchIgnitionLoginViaKiosk } from "@/lib/kioskBridge";
import { IntegrationsSettings } from "@/components/IntegrationsSettings";

const ADMIN_PIN = process.env.NEXT_PUBLIC_ADMIN_PIN || "0000";

interface Templates {
  onWay: string;
  arrived: string;
  coordinatorOnWay: string;
  coordinatorArrived: string;
  onWayPickup: string;
  arrivedPickup: string;
  coordinatorOnWayPickup: string;
  coordinatorArrivedPickup: string;
}
interface Settings {
  companyName: string;
  timezone: string;
  notifyPhone: string;
  ignitionUrl: string;
  ignitionEtaLinks: Record<string, string>;
  ignitionUnits: Record<string, number>;
  templates: Templates;
  smsProvider: string;
  gpsProvider: string;
  gpsVehicleIds: Record<string, string>;
}

// Each slot has a delivery and a pickup variant; the toggle picks which set is edited.
const TEMPLATE_SLOTS: {
  keys: { delivery: keyof Templates; pickup: keyof Templates };
  label: string;
  hint: string;
}[] = [
  { keys: { delivery: "onWay", pickup: "onWayPickup" }, label: "Customer — on the way", hint: "Sent when the driver leaves for this stop." },
  { keys: { delivery: "arrived", pickup: "arrivedPickup" }, label: "Customer — arrived", hint: "Sent when the driver arrives." },
  { keys: { delivery: "coordinatorOnWay", pickup: "coordinatorOnWayPickup" }, label: "Coordinator — on the way", hint: "Day-of coordinator, if the stop has one." },
  { keys: { delivery: "coordinatorArrived", pickup: "coordinatorArrivedPickup" }, label: "Coordinator — arrived", hint: "Day-of coordinator, if the stop has one." },
];

const VARS = [
  ["{firstName}", "First name"],
  ["{custName}", "Customer / event"],
  ["{company}", "Company"],
  ["{truck}", "Truck"],
  ["{address}", "Address"],
  ["{eta}", "ETA"],
  ["{window}", "Window"],
  ["{link}", "Tracking link"],
];

export default function AdminPage() {
  const [pin, setPin] = useState("");
  const [authed, setAuthed] = useState(false);
  const [pinError, setPinError] = useState(false);

  const [s, setS] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Whether this page is running inside the tablet/desktop kiosk (only there can we
  // switch the Goodshuffle / Ignition WebView sessions).
  const [inKiosk, setInKiosk] = useState(false);
  useEffect(() => setInKiosk(isKiosk()), []);
  // Which template set the Message templates editor is showing.
  const [tplMode, setTplMode] = useState<"delivery" | "pickup">("delivery");

  useEffect(() => {
    if (!authed) return;
    setLoading(true);
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: Settings) => setS(data))
      .catch(() => setError("Could not load settings."))
      .finally(() => setLoading(false));
  }, [authed]);

  const trucks = useMemo(() => {
    if (!s) return [];
    return Array.from(new Set([...Object.keys(s.ignitionUnits), ...Object.keys(s.ignitionEtaLinks)])).sort();
  }, [s]);

  function tryAuth() {
    if (pin === ADMIN_PIN) {
      setAuthed(true);
      setPinError(false);
    } else {
      setPinError(true);
      setPin("");
    }
  }

  async function save() {
    if (!s) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-pin": pin },
        body: JSON.stringify(s),
      });
      if (!r.ok) {
        setError(r.status === 401 ? "Wrong admin code — can't save." : `Save failed (${r.status}).`);
        return;
      }
      const data = (await r.json()) as { settings: Settings };
      setS(data.settings);
      setSavedAt(Date.now());
    } catch {
      setError("Save failed — network error.");
    } finally {
      setSaving(false);
    }
  }

  // ── PIN gate ──────────────────────────────────────────────────────────────
  if (!authed) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center p-6">
        <div className="surface rounded-2xl border border-white/10 p-6">
          <div className="mb-1 flex items-center gap-2 text-lg font-semibold">
            <ShieldCheck className="size-5" /> Admin settings
          </div>
          <p className="mb-4 text-sm text-muted-foreground">Enter the admin code to manage settings.</p>
          <input
            autoFocus
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => {
              setPin(e.target.value.replace(/\D/g, "").slice(0, 8));
              setPinError(false);
            }}
            onKeyDown={(e) => e.key === "Enter" && tryAuth()}
            placeholder="••••"
            className="w-full rounded-xl border border-white/10 bg-background px-4 py-3 text-center text-2xl tracking-[0.4em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {pinError && <p className="mt-2 text-center text-sm text-red-400">Wrong code</p>}
          <button
            onClick={tryAuth}
            className="btn-hero mt-4 w-full rounded-xl px-4 py-3 text-sm font-medium"
          >
            Unlock
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl p-5 pb-24">
      <header className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">Customize the app for your team — no code needed.</p>
        </div>
        <SaveButton saving={saving} savedAt={savedAt} onClick={save} disabled={!s} />
      </header>

      {error && (
        <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading || !s ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="space-y-8">
          {/* General */}
          <Section icon={<Building2 className="size-4" />} title="General">
            <Field label="Company name">
              <TextInput value={s.companyName} onChange={(v) => setS({ ...s, companyName: v })} />
            </Field>
            <Field label="Timezone" hint="IANA name, e.g. America/New_York">
              <TextInput value={s.timezone} onChange={(v) => setS({ ...s, timezone: v })} />
            </Field>
            <Field label="ETA notify number" hint="Zonar texts this number — keep it your company line, never a customer's.">
              <TextInput value={s.notifyPhone} onChange={(v) => setS({ ...s, notifyPhone: v })} />
            </Field>
          </Section>

          {/* Ignition */}
          <Section icon={<Radio className="size-4" />} title="Ignition (Zonar)">
            <Field label="Ignition URL" hint="Shown in the dispatch pane / office board view.">
              <TextInput
                value={s.ignitionUrl}
                onChange={(v) => setS({ ...s, ignitionUrl: v })}
                placeholder="https://ignition.zonarsystems.com/app/realtimemaps/main"
              />
            </Field>
            <div className="space-y-2">
              <div className="text-sm font-medium">Per-truck ETA link &amp; unit id</div>
              <p className="text-xs text-muted-foreground">
                The static Zonar ETA-share link and the telematics unit id for each truck.
              </p>
              <div className="space-y-2">
                {trucks.map((t) => (
                  <div key={t} className="grid grid-cols-[5rem_1fr_7rem] items-center gap-2">
                    <span className="text-sm font-medium tabular-nums">{t}</span>
                    <TextInput
                      value={s.ignitionEtaLinks[t] ?? ""}
                      placeholder="ETA link URL"
                      onChange={(v) =>
                        setS({ ...s, ignitionEtaLinks: { ...s.ignitionEtaLinks, [t]: v } })
                      }
                    />
                    <TextInput
                      value={s.ignitionUnits[t] != null ? String(s.ignitionUnits[t]) : ""}
                      placeholder="unit id"
                      onChange={(v) =>
                        setS({
                          ...s,
                          ignitionUnits: { ...s.ignitionUnits, [t]: Number(v.replace(/\D/g, "")) || 0 },
                        })
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
          </Section>

          {/* Integrations — switch GPS + phone provider */}
          <Section icon={<PlugZap className="size-4" />} title="Integrations">
            <IntegrationsSettings
              smsProvider={s.smsProvider}
              gpsProvider={s.gpsProvider}
              gpsVehicleIds={s.gpsVehicleIds ?? {}}
              trucks={trucks}
              pin={pin}
              onChange={(patch) => setS({ ...s, ...patch })}
            />
          </Section>

          {/* Tablet sign-ins (Goodshuffle / Ignition) */}
          <Section icon={<KeyRound className="size-4" />} title="Tablet sign-ins">
            <p className="text-sm text-muted-foreground">
              Goodshuffle and Ignition are signed in on each tablet (and the office
              display) — there are no passwords to store here. To switch accounts, sign the
              current one out on the device and sign the new one in.
            </p>
            {inKiosk ? (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => switchGoodshuffleLoginViaKiosk()}
                  className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-4 py-2.5 text-sm hover:bg-accent"
                >
                  <LogIn className="size-4" /> Switch Goodshuffle login
                </button>
                <button
                  type="button"
                  onClick={() => switchIgnitionLoginViaKiosk()}
                  className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-4 py-2.5 text-sm hover:bg-accent"
                >
                  <LogIn className="size-4" /> Switch Ignition login
                </button>
              </div>
            ) : (
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-sm text-muted-foreground">
                You&apos;re viewing this in a regular browser, so there&apos;s no tablet
                session to switch here. Open this on the tablet or office display and use{" "}
                <span className="font-medium text-foreground">⋯ → Admin</span> to switch a
                Goodshuffle or Ignition login.
              </div>
            )}
          </Section>

          {/* Templates */}
          <Section icon={<MessageSquareText className="size-4" />} title="Message templates">
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">Variables you can use</div>
              <div className="flex flex-wrap gap-1.5">
                {VARS.map(([token, desc]) => (
                  <span
                    key={token}
                    title={desc}
                    className="rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[11px]"
                  >
                    {token}
                  </span>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                A line containing <span className="font-mono">{"{link}"}</span> is dropped when there&apos;s no
                tracking link for that stop.
              </p>
            </div>

            {/* Delivery / Pickup toggle — each stop uses the set matching its type. */}
            <div className="inline-flex rounded-xl border border-white/10 bg-white/[0.03] p-1 text-sm">
              {(["delivery", "pickup"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setTplMode(m)}
                  className={`rounded-lg px-4 py-1.5 font-medium capitalize transition-colors ${
                    tplMode === m ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
            <p className="-mt-2 text-xs text-muted-foreground">
              Zoe Dispatch reads each stop&apos;s type from Goodshuffle and automatically uses the{" "}
              <span className="font-medium capitalize text-foreground">{tplMode}</span> wording below for it.
            </p>

            {TEMPLATE_SLOTS.map((f) => {
              const key = f.keys[tplMode];
              return (
                <Field key={key} label={f.label} hint={f.hint}>
                  <textarea
                    value={s.templates[key]}
                    onChange={(e) => setS({ ...s, templates: { ...s.templates, [key]: e.target.value } })}
                    rows={f.keys.delivery.startsWith("coordinator") || f.keys.delivery === "onWay" ? 5 : 3}
                    className="w-full resize-y rounded-xl border border-white/10 bg-background px-3 py-2 text-sm leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </Field>
              );
            })}
          </Section>

          <div className="flex justify-end">
            <SaveButton saving={saving} savedAt={savedAt} onClick={save} disabled={!s} />
          </div>
        </div>
      )}
    </main>
  );
}

function SaveButton({
  saving,
  savedAt,
  onClick,
  disabled,
}: {
  saving: boolean;
  savedAt: number | null;
  onClick: () => void;
  disabled?: boolean;
}) {
  const justSaved = savedAt != null && Date.now() - savedAt < 2500;
  return (
    <button
      onClick={onClick}
      disabled={saving || disabled}
      className="btn-hero inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium disabled:opacity-50"
    >
      {saving ? <Loader2 className="size-4 animate-spin" /> : justSaved ? <Check className="size-4" /> : <Save className="size-4" />}
      {saving ? "Saving…" : justSaved ? "Saved" : "Save changes"}
    </button>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="surface space-y-4 rounded-2xl border border-white/5 p-5">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">{label}</label>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
    </div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-xl border border-white/10 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  );
}
