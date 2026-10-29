"use client";

// Team-facing settings — "customize outside of code". Edit message templates, the
// Ignition link, per-truck ETA links / unit ids, company name and timezone, then Save.
// Soft-gated by a 4-digit admin code (NEXT_PUBLIC_ADMIN_PIN, default 0000); the write
// is verified server-side. No secrets live here.

import { useEffect, useMemo, useState } from "react";
import { Loader2, Save, Check, ShieldCheck, MessageSquareText, Radio, Building2, KeyRound, LogIn, PlugZap, Search, CalendarRange, Truck, Timer, Trash2, Users, Globe, Clock3, Boxes, Plus, X, UserCheck } from "lucide-react";
import type { BusinessHoursSchedule, DayHours } from "@/lib/businessHours";
import { isSlackUserId, type SlackApprover } from "@/lib/slack/approvers";
import { isKiosk, switchGoodshuffleLoginViaKiosk, switchIgnitionLoginViaKiosk } from "@/lib/kioskBridge";
import { IntegrationsSettings } from "@/components/IntegrationsSettings";
import { InstaworkCredentialSettings } from "@/components/InstaworkCredentialSettings";
import { OpsCycleSettings } from "@/components/OpsCycleSettings";
import { PricingSettings } from "@/components/PricingSettings";
import { RuntimeStatus } from "@/components/RuntimeStatus";
import { ForcePruneBookings } from "@/components/ForcePruneBookings";

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
  premiumWindowKeywords: string[];
  eventReadinessKeywords: string[];
  heavyItemKeywords: string[];
  monitorUrls: string[];
  businessHours: BusinessHoursSchedule;
  zoeCategories: ZoeCategory[];
  slackApprovers: SlackApprover[];
  seoZoeDomain: string;
  seoCompetitorDomains: string[];
}
interface ZoeCategory {
  name: string;
  primaryCategoryID: number;
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

          {/* Slack approvers — who may approve/dismiss an AI action from the Slack approval-card buttons. */}
          <Section icon={<UserCheck className="size-4" />} title="Slack approvers">
            <p className="text-sm text-muted-foreground">
              These people can approve or dismiss an AI action (like sending a quote) straight from the buttons on
              a Slack approval card. Anyone not listed is told to decide in the app instead. With no one listed,
              nobody can approve from Slack — decisions still work on the approvals page in the app.
            </p>
            <ApproversEditor value={s.slackApprovers ?? []} onChange={(v) => setS({ ...s, slackApprovers: v })} />
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

          {/* SEO Growth — the gap engine's own + competitor domains (read from live Google SERPs). */}
          <Section icon={<Search className="size-4" />} title="SEO Growth (competitive gap)">
            <Field label="Zoe domain" hint="Zoe's own public domain — the engine finds Zoe's listing and rank in each SERP.">
              <TextInput value={s.seoZoeDomain ?? ""} onChange={(v) => setS({ ...s, seoZoeDomain: v })} />
            </Field>
            <KeywordList
              label="Competitor domains"
              hint="Local rivals to surface first (comma-separated hosts). The engine already treats any non-Zoe, non-directory domain on a read SERP as a competitor; this is the curated set."
              value={s.seoCompetitorDomains ?? []}
              onChange={(v) => setS({ ...s, seoCompetitorDomains: v })}
            />
            <p className="text-[12px] text-muted-foreground">
              SERP data is read on the office machine (tools/seo-runner), not here — Google blocks our server. Set these, then run the runner.
            </p>
          </Section>

          <Section icon={<Search className="size-4" />} title="Instawork (temp labor)">
            <InstaworkCredentialSettings />
          </Section>

          <Section icon={<Truck className="size-4" />} title="Delivery pricing">
            <PricingSettings />
          </Section>

          <Section icon={<CalendarRange className="size-4" />} title="Operational cycle (Financial Intelligence)">
            <OpsCycleSettings />
          </Section>

          <Section icon={<PlugZap className="size-4" />} title="Cloud runtime">
            <RuntimeStatus />
          </Section>

          <Section icon={<Trash2 className="size-4" />} title="Goodshuffle cleanup">
            <ForcePruneBookings pin={pin} />
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

          {/* Driver debrief — the keyword lists that flip on the time-sensitive / event-readiness callouts. */}
          <Section icon={<Timer className="size-4" />} title="Driver debrief callouts">
            <p className="text-sm text-muted-foreground">
              The pre-shift debrief (sent to route crew ~2 hours before start) adds extra lines when a stop&apos;s
              Goodshuffle quote carries one of these line items. Match is by name, case-insensitive, any part of
              the name. Separate keywords with commas.
            </p>
            <KeywordList
              label="Premium / exact-time arrival window"
              hint='Adds the "mind the stop timings" reminder. The Zoe products all contain "Arrival Window", so that one keyword catches Premium Time, Exact Time and Elite Hour (delivery and pickup).'
              value={s.premiumWindowKeywords ?? []}
              onChange={(v) => setS({ ...s, premiumWindowKeywords: v })}
            />
            <KeywordList
              label="Event Readiness Service"
              hint="Names the customer in the debrief so the crew plans setup time."
              value={s.eventReadinessKeywords ?? []}
              onChange={(v) => setS({ ...s, eventReadinessKeywords: v })}
            />
          </Section>

          {/* Crew-size rules — heavy items that always need a second person on the truck. */}
          <Section icon={<Users className="size-4" />} title="Crew size rules">
            <p className="text-sm text-muted-foreground">
              Any order whose line items match one of these keywords always needs at least 2 people on the
              delivery. Match is by name, case-insensitive, any part of the name. This only ever raises the crew
              floor, so a big tent that already needs more crew is unaffected. Separate keywords with commas.
            </p>
            <KeywordList
              label="Heavy items (require 2 or more crew)"
              hint='Default "folding farm table" catches the Antique Rustic Solid Pine Folding Farm Table (96 inch, big and heavy) without tripping on a plain table. Add other heavy items as needed.'
              value={s.heavyItemKeywords ?? []}
              onChange={(v) => setS({ ...s, heavyItemKeywords: v })}
            />
          </Section>

          {/* Website uptime monitor — the public URLs the always-on uptime probe checks for HTTP 200. */}
          <Section icon={<Globe className="size-4" />} title="Website monitor">
            <p className="text-sm text-muted-foreground">
              The runtime checks each of these URLs every 15 minutes and alerts the ops Slack channel if one
              stops returning HTTP 200. This runs around the clock (a site being down is urgent), not just in
              business hours. Default is your homepage. Separate URLs with commas.
            </p>
            <KeywordList
              label="Monitored URLs"
              hint="Full URLs including https://. The homepage is a good default; add key landing pages if you want them watched too."
              value={s.monitorUrls ?? []}
              onChange={(v) => setS({ ...s, monitorUrls: v })}
            />
          </Section>

          {/* Business hours — the window in which the AI bots are allowed to make recommendations / send. */}
          <Section icon={<Clock3 className="size-4" />} title="Business hours">
            <p className="text-sm text-muted-foreground">
              The AI assistants hold their recommendations and customer-facing messages until business hours. Outside
              these windows the work is held, not dropped, and runs on the next tick inside hours. Times are in your
              operating timezone. A day with no hours is closed. Operational and safety alerts (dispatch, route health,
              data-pull health, frustrated-caller) are always on and ignore this.
            </p>
            <BusinessHoursEditor value={s.businessHours ?? {}} onChange={(v) => setS({ ...s, businessHours: v })} />
          </Section>

          {/* Inventory categories — the Zoe destination categories the Inventory Automation importer files
              copied items under. Each needs a Goodshuffle numeric category id. */}
          <Section icon={<Boxes className="size-4" />} title="Inventory categories">
            <p className="text-sm text-muted-foreground">
              Inventory Automation copies a partner&apos;s items into these Zoe categories. Each needs the Goodshuffle
              numeric category id so the importer files items correctly — it will not guess, and a mapping to a
              category with no id here cannot be imported. The id comes from an existing item already filed under
              that category in Goodshuffle (there is no public lookup). Add a new category here to use it without a
              deploy.
            </p>
            <ZoeCategoriesEditor value={s.zoeCategories ?? []} onChange={(v) => setS({ ...s, zoeCategories: v })} />
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

// A weekly business-hours editor: one row per weekday with an Open checkbox and two time inputs. Unchecking
// Open sets that day closed (null). Times are "HH:MM" wall-clock in the operating timezone; the server
// re-sanitizes on save (a bad entry falls back to the in-code default for that weekday).
const WEEKDAY_LABELS: [string, string][] = [
  ["1", "Monday"],
  ["2", "Tuesday"],
  ["3", "Wednesday"],
  ["4", "Thursday"],
  ["5", "Friday"],
  ["6", "Saturday"],
  ["0", "Sunday"],
];

function BusinessHoursEditor({
  value,
  onChange,
}: {
  value: BusinessHoursSchedule;
  onChange: (v: BusinessHoursSchedule) => void;
}) {
  const setDay = (key: string, day: DayHours | null): void => onChange({ ...value, [key]: day });
  return (
    <div className="space-y-2">
      {WEEKDAY_LABELS.map(([key, label]) => {
        const day = value[key] ?? null;
        const openChecked = day != null;
        return (
          <div key={key} className="flex flex-wrap items-center gap-3">
            <label className="flex w-40 items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={openChecked}
                onChange={(e) => setDay(key, e.target.checked ? day ?? { open: "10:00", close: "18:00" } : null)}
                className="size-4 accent-[var(--accent,currentColor)]"
              />
              {label}
            </label>
            {openChecked ? (
              <div className="flex items-center gap-2 text-sm">
                <input
                  type="time"
                  value={day?.open ?? "10:00"}
                  onChange={(e) => setDay(key, { open: e.target.value || "10:00", close: day?.close ?? "18:00" })}
                  className="rounded-xl border border-white/10 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <span className="text-muted-foreground">to</span>
                <input
                  type="time"
                  value={day?.close ?? "18:00"}
                  onChange={(e) => setDay(key, { open: day?.open ?? "10:00", close: e.target.value || "18:00" })}
                  className="rounded-xl border border-white/10 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
            ) : (
              <span className="text-sm text-muted-foreground">Closed</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Editor for the Zoe destination-category registry: rows of { name, primaryCategoryID } with add/remove. The
// server coerces + de-dupes on save (dropping rows without a name or a finite id), and the normalized list
// flows back on the next load.
function ZoeCategoriesEditor({
  value,
  onChange,
}: {
  value: ZoeCategory[];
  onChange: (v: ZoeCategory[]) => void;
}) {
  const setRow = (i: number, patch: Partial<ZoeCategory>) =>
    onChange(value.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  const removeRow = (i: number) => onChange(value.filter((_, idx) => idx !== i));
  const addRow = () => onChange([...value, { name: "", primaryCategoryID: 0 }]);
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[1fr_8rem_2.5rem] items-center gap-2 text-xs text-muted-foreground">
        <span>Category name</span>
        <span>Goodshuffle id</span>
        <span />
      </div>
      {value.map((c, i) => (
        <div key={i} className="grid grid-cols-[1fr_8rem_2.5rem] items-center gap-2">
          <input
            type="text"
            value={c.name}
            placeholder="e.g. Sofas"
            onChange={(e) => setRow(i, { name: e.target.value })}
            className="w-full rounded-xl border border-white/10 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <input
            type="text"
            inputMode="numeric"
            value={c.primaryCategoryID ? String(c.primaryCategoryID) : ""}
            placeholder="657"
            onChange={(e) => setRow(i, { primaryCategoryID: Number(e.target.value.replace(/\D/g, "")) || 0 })}
            className="w-full rounded-xl border border-white/10 bg-background px-3 py-2 text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="button"
            onClick={() => removeRow(i)}
            aria-label="Remove category"
            className="inline-flex size-9 items-center justify-center rounded-xl border border-white/10 text-muted-foreground hover:bg-accent"
          >
            <X className="size-4" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addRow}
        className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-3 py-2 text-sm text-muted-foreground hover:bg-accent"
      >
        <Plus className="size-4" /> Add category
      </button>
    </div>
  );
}

// Editor for the Slack approver list. Loads the workspace directory from /api/slack/users so approvers can be
// added by NAME (a picker); if the bot token isn't set or the directory can't load, it falls back to manual
// member-id entry. Stored approvers from the env default have no name — we resolve a display name from the
// directory by id when we can, else show the raw id. The server coerces/validates on save.
interface WorkspaceUser {
  id: string;
  name: string;
  realName: string;
}

function ApproversEditor({ value, onChange }: { value: SlackApprover[]; onChange: (v: SlackApprover[]) => void }) {
  const [users, setUsers] = useState<WorkspaceUser[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [pick, setPick] = useState("");
  const [manualId, setManualId] = useState("");
  const [manualName, setManualName] = useState("");
  const [manualErr, setManualErr] = useState(false);

  useEffect(() => {
    fetch("/api/slack/users")
      .then((r) => r.json())
      .then((d: { users?: WorkspaceUser[]; configured?: boolean }) => {
        setUsers(Array.isArray(d.users) ? d.users : []);
        setConfigured(d.configured !== false);
      })
      .catch(() => {
        setUsers([]);
        setConfigured(false);
      })
      .finally(() => setLoaded(true));
  }, []);

  const nameById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const u of users) m[u.id] = u.realName || u.name || u.id;
    return m;
  }, [users]);

  const addedIds = new Set(value.map((a) => a.id));
  const available = users.filter((u) => !addedIds.has(u.id));

  const add = (id: string, name: string): void => {
    if (!isSlackUserId(id) || addedIds.has(id)) return;
    onChange([...value, { id, name }]);
  };
  const remove = (id: string): void => onChange(value.filter((a) => a.id !== id));
  const addFromPicker = (): void => {
    const u = users.find((x) => x.id === pick);
    if (!u) return;
    add(u.id, u.realName || u.name || "");
    setPick("");
  };
  const addManual = (): void => {
    const id = manualId.trim();
    if (!isSlackUserId(id)) {
      setManualErr(true);
      return;
    }
    add(id, manualName.trim());
    setManualId("");
    setManualName("");
    setManualErr(false);
  };

  const usePicker = loaded && configured && users.length > 0;

  return (
    <div className="space-y-3">
      {value.length === 0 ? (
        <p className="text-xs text-amber-400/90">No Slack approvers yet — no one can approve from Slack right now.</p>
      ) : (
        <div className="space-y-2">
          {value.map((a) => (
            <div
              key={a.id}
              className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{a.name || nameById[a.id] || a.id}</div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">{a.id}</div>
              </div>
              <button
                type="button"
                onClick={() => remove(a.id)}
                aria-label="Remove approver"
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-white/10 text-muted-foreground hover:bg-accent"
              >
                <X className="size-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {usePicker ? (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            className="min-w-[14rem] flex-1 rounded-xl border border-white/10 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">Add a person…</option>
            {available.map((u) => (
              <option key={u.id} value={u.id}>
                {u.realName || u.name || u.id}
                {u.name && u.realName ? ` (@${u.name})` : ""}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={addFromPicker}
            disabled={!pick}
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-3 py-2 text-sm text-muted-foreground hover:bg-accent disabled:opacity-50"
          >
            <Plus className="size-4" /> Add
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {loaded && (
            <p className="text-xs text-muted-foreground">
              {configured ? "Couldn't load your Slack directory. " : "Connect the Slack bot token to pick people by name. "}
              Add by Slack member id instead — in Slack, open a person&apos;s profile → ⋯ → Copy member ID.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={manualId}
              placeholder="U0123ABCD"
              onChange={(e) => {
                setManualId(e.target.value.trim());
                setManualErr(false);
              }}
              className="w-40 rounded-xl border border-white/10 bg-background px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <input
              type="text"
              value={manualName}
              placeholder="Name (optional)"
              onChange={(e) => setManualName(e.target.value)}
              className="min-w-[8rem] flex-1 rounded-xl border border-white/10 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <button
              type="button"
              onClick={addManual}
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-3 py-2 text-sm text-muted-foreground hover:bg-accent"
            >
              <Plus className="size-4" /> Add
            </button>
          </div>
          {manualErr && <p className="text-xs text-red-400">That doesn&apos;t look like a Slack member id (it starts with U).</p>}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">Changes take effect when you click Save.</p>
    </div>
  );
}

// A comma-separated keyword-list editor. Edits as free text (so typing a comma doesn't fight the array), and
// only commits the parsed, trimmed, non-empty list to the parent on change. The server lowercases + de-dupes
// on save, then the normalized list flows back on the next load.
function KeywordList({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const [text, setText] = useState(value.join(", "));
  // Re-sync when the saved (normalized) value changes out from under us, but not on every keystroke.
  useEffect(() => {
    setText(value.join(", "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.join("\u0001")]);
  return (
    <Field label={label} hint={hint}>
      <input
        type="text"
        value={text}
        placeholder="keyword, another keyword"
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value.split(",").map((k) => k.trim()).filter(Boolean));
        }}
        className="w-full rounded-xl border border-white/10 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {value.map((k) => (
            <span key={k} className="rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[11px]">
              {k}
            </span>
          ))}
        </div>
      )}
    </Field>
  );
}
