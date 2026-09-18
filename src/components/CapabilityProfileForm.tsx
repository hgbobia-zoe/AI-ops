"use client";

// Zoe Capability Profile — the fillable, reusable company record. Fill it once here; bid pursuit
// (capability statements, solicitation responses, subcontractor outreach) draws from this ONE record so
// nothing gets retyped or invented per-bid. FACTS ONLY — the form never generates or guesses a value;
// unknown stays blank. Loads via GET /api/pursuit/capability-profile, saves via POST.

import { useCallback, useEffect, useState } from "react";
import { Building2, ShieldCheck, Award, Umbrella, Sparkles, History, Contact, Plus, Trash2, Loader2, Check, IdCard } from "lucide-react";
import {
  CERT_OPTIONS,
  emptyProfile,
  profileCompleteness,
  type CapabilityProfile,
  type PastProject,
} from "@/lib/pursuit/capabilityProfileShape";

const INPUT =
  "w-full rounded-xl border border-white/10 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const AREA = INPUT + " min-h-[76px] resize-y";

function Field({
  label,
  hint,
  children,
  wide,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  wide?: boolean;
}): React.JSX.Element {
  return (
    <label className={`space-y-1.5 ${wide ? "sm:col-span-2" : ""}`}>
      <span className="text-sm font-medium">
        {label}
        {hint && <span className="ml-1.5 font-normal text-muted-foreground">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function Section({
  icon: Icon,
  title,
  desc,
  children,
}: {
  icon: typeof Building2;
  title: string;
  desc?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="surface space-y-4 rounded-2xl border border-white/5 p-5">
      <div className="space-y-1">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Icon className="size-4" /> {title}
        </h2>
        {desc && <p className="text-sm text-muted-foreground">{desc}</p>}
      </div>
      {children}
    </section>
  );
}

export function CapabilityProfileForm(): React.JSX.Element {
  const [p, setP] = useState<CapabilityProfile>(emptyProfile);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/pursuit/capability-profile")
      .then((r) => r.json())
      .then((j: { profile?: CapabilityProfile }) => {
        if (j.profile) setP({ ...emptyProfile(), ...j.profile });
      })
      .catch(() => setError("Could not load the profile."))
      .finally(() => setLoading(false));
  }, []);

  // One generic setter keeps the form terse — every text field is `set("legalName")(e.target.value)`.
  const set = useCallback(
    <K extends keyof CapabilityProfile>(key: K) =>
      (value: CapabilityProfile[K]) => {
        setSavedAt(null);
        setP((prev) => ({ ...prev, [key]: value }));
      },
    [],
  );

  const toggleCert = (value: string) => {
    setSavedAt(null);
    setP((prev) => ({
      ...prev,
      certifications: prev.certifications.includes(value)
        ? prev.certifications.filter((c) => c !== value)
        : [...prev.certifications, value],
    }));
  };

  const setPast = (i: number, patch: Partial<PastProject>) => {
    setSavedAt(null);
    setP((prev) => ({
      ...prev,
      pastPerformance: prev.pastPerformance.map((row, idx) => (idx === i ? { ...row, ...patch } : row)),
    }));
  };
  const addPast = () => {
    setSavedAt(null);
    setP((prev) => ({ ...prev, pastPerformance: [...prev.pastPerformance, { name: "", detail: "", year: "" }] }));
  };
  const removePast = (i: number) => {
    setSavedAt(null);
    setP((prev) => ({ ...prev, pastPerformance: prev.pastPerformance.filter((_, idx) => idx !== i) }));
  };

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/pursuit/capability-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p),
      });
      const j = (await r.json()) as { ok?: boolean; profile?: CapabilityProfile; error?: string };
      if (!r.ok || !j.ok || !j.profile) {
        setError(j.error === "forbidden" ? "You don't have access to edit this." : "Could not save. Try again.");
        return;
      }
      setP({ ...emptyProfile(), ...j.profile }); // reflect the trimmed/stamped copy
      setSavedAt(j.profile.updatedAt ?? new Date().toISOString());
    } catch {
      setError("Could not save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading profile…
        </div>
      </main>
    );
  }

  const pct = Math.round(profileCompleteness(p) * 100);

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6 sm:p-8">
      <header className="space-y-2">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <IdCard className="size-6" /> Capability Profile
        </h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Zoe&apos;s reusable company record. Fill it once; every bid package (capability statement,
          solicitation response, subcontractor outreach) draws from here so nothing gets retyped. Facts
          only — leave anything you don&apos;t have blank rather than guessing.
        </p>
        <div className="flex items-center gap-3 pt-1">
          <div className="h-1.5 w-40 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-foreground/70 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-xs text-muted-foreground">{pct}% complete</span>
        </div>
      </header>

      <Section icon={Building2} title="Company">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Legal name">
            <input className={INPUT} value={p.legalName} onChange={(e) => set("legalName")(e.target.value)} placeholder="Zoe Events DMV LLC" />
          </Field>
          <Field label="DBA / trade name" hint="(if any)">
            <input className={INPUT} value={p.dba} onChange={(e) => set("dba")(e.target.value)} />
          </Field>
          <Field label="Website">
            <input className={INPUT} value={p.website} onChange={(e) => set("website")(e.target.value)} placeholder="zoeeventsdmv.com" />
          </Field>
          <Field label="Founded" hint="(year)">
            <input className={INPUT} value={p.foundedYear} onChange={(e) => set("foundedYear")(e.target.value)} placeholder="2018" inputMode="numeric" />
          </Field>
          <Field label="Phone">
            <input className={INPUT} value={p.phone} onChange={(e) => set("phone")(e.target.value)} placeholder="(301) 291-5296" />
          </Field>
          <Field label="Email">
            <input className={INPUT} value={p.email} onChange={(e) => set("email")(e.target.value)} placeholder="hello@zoeeventsdmv.com" />
          </Field>
          <Field label="Business address" wide>
            <input className={INPUT} value={p.address} onChange={(e) => set("address")(e.target.value)} />
          </Field>
          <Field label="Service area" hint="(where Zoe works)" wide>
            <input className={INPUT} value={p.serviceArea} onChange={(e) => set("serviceArea")(e.target.value)} placeholder="DC, Maryland (Montgomery, Prince George's), Northern Virginia" />
          </Field>
        </div>
      </Section>

      <Section icon={ShieldCheck} title="Federal registration" desc="Only for federal / SAM.gov solicitations. Leave blank if not yet registered.">
        <label className="flex items-center gap-2.5 text-sm font-medium">
          <input type="checkbox" className="size-4 accent-foreground" checked={p.samRegistered} onChange={(e) => set("samRegistered")(e.target.checked)} />
          Registered and active in SAM.gov
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="UEI" hint="(Unique Entity ID)">
            <input className={INPUT} value={p.uei} onChange={(e) => set("uei")(e.target.value)} />
          </Field>
          <Field label="CAGE code">
            <input className={INPUT} value={p.cageCode} onChange={(e) => set("cageCode")(e.target.value)} />
          </Field>
          <Field label="NAICS codes" hint="(comma-separated)" wide>
            <input className={INPUT} value={p.naicsCodes} onChange={(e) => set("naicsCodes")(e.target.value)} placeholder="532289, 532490, 722320" />
          </Field>
        </div>
      </Section>

      <Section icon={Award} title="Certifications" desc="Check any Zoe currently holds. These drive set-aside eligibility.">
        <div className="grid gap-2 sm:grid-cols-2">
          {CERT_OPTIONS.map((c) => {
            const on = p.certifications.includes(c.value);
            return (
              <button
                key={c.value}
                type="button"
                onClick={() => toggleCert(c.value)}
                className={`flex items-center gap-2.5 rounded-xl border p-3 text-left text-sm transition-colors ${
                  on ? "border-foreground bg-foreground/10 font-medium" : "border-white/10 hover:bg-accent"
                }`}
              >
                <span className={`flex size-4 shrink-0 items-center justify-center rounded border ${on ? "border-foreground bg-foreground text-background" : "border-white/25"}`}>
                  {on && <Check className="size-3" />}
                </span>
                {c.label}
              </button>
            );
          })}
        </div>
        <Field label="Other certifications" hint="(anything not listed above)" wide>
          <input className={INPUT} value={p.certificationsOther} onChange={(e) => set("certificationsOther")(e.target.value)} />
        </Field>
      </Section>

      <Section icon={Umbrella} title="Insurance" desc="Coverage limits, as they'd appear on a certificate of insurance.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="General liability">
            <input className={INPUT} value={p.generalLiability} onChange={(e) => set("generalLiability")(e.target.value)} placeholder="$2,000,000 per occurrence" />
          </Field>
          <Field label="Auto liability">
            <input className={INPUT} value={p.autoLiability} onChange={(e) => set("autoLiability")(e.target.value)} />
          </Field>
          <Field label="Workers' comp">
            <input className={INPUT} value={p.workersComp} onChange={(e) => set("workersComp")(e.target.value)} />
          </Field>
          <Field label="Umbrella / excess">
            <input className={INPUT} value={p.umbrella} onChange={(e) => set("umbrella")(e.target.value)} />
          </Field>
        </div>
        <label className="flex items-center gap-2.5 text-sm font-medium">
          <input type="checkbox" className="size-4 accent-foreground" checked={p.providesAdditionalInsured} onChange={(e) => set("providesAdditionalInsured")(e.target.checked)} />
          Can name the client as additional insured on request
        </label>
      </Section>

      <Section icon={Sparkles} title="Capabilities" desc="What Zoe does, at what scale, and why choose Zoe. Used verbatim in capability statements.">
        <Field label="Core competencies" hint="(services / inventory)" wide>
          <textarea className={AREA} value={p.coreCompetencies} onChange={(e) => set("coreCompetencies")(e.target.value)} placeholder="Full-service event rentals: tents, tables, chairs, linens, lounge furniture, staging, delivery, setup and breakdown." />
        </Field>
        <Field label="Capacity" hint="(largest events, fleet, crew, lead time)" wide>
          <textarea className={AREA} value={p.capacitySummary} onChange={(e) => set("capacitySummary")(e.target.value)} placeholder="Events up to 1,500 guests; box-truck fleet; W-2 and vetted contract crews; 2-week standard lead, rush available." />
        </Field>
        <Field label="Differentiators" hint="(why Zoe wins)" wide>
          <textarea className={AREA} value={p.differentiators} onChange={(e) => set("differentiators")(e.target.value)} />
        </Field>
      </Section>

      <Section icon={History} title="Past performance" desc="Real, delivered events only. These become the reference list on a bid. Unknown year is fine.">
        <div className="space-y-3">
          {p.pastPerformance.length === 0 && (
            <p className="text-sm text-muted-foreground">No entries yet. Add a delivered event you can reference.</p>
          )}
          {p.pastPerformance.map((row, i) => (
            <div key={i} className="grid gap-2 rounded-xl border border-white/10 p-3 sm:grid-cols-[1fr_1.6fr_auto]">
              <input className={INPUT} value={row.name} onChange={(e) => setPast(i, { name: e.target.value })} placeholder="Client / event / venue" />
              <input className={INPUT} value={row.detail} onChange={(e) => setPast(i, { detail: e.target.value })} placeholder="What Zoe provided" />
              <div className="flex gap-2">
                <input className={INPUT + " w-20"} value={row.year} onChange={(e) => setPast(i, { year: e.target.value })} placeholder="Year" inputMode="numeric" />
                <button type="button" onClick={() => removePast(i)} aria-label="Remove entry" className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-white/10 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                  <Trash2 className="size-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
        <button type="button" onClick={addPast} className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-3 py-2 text-sm font-medium transition-colors hover:bg-accent">
          <Plus className="size-4" /> Add event
        </button>
      </Section>

      <Section icon={Contact} title="Bid point of contact" desc="Who signs and answers on a solicitation. Often the owner.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <input className={INPUT} value={p.bidContactName} onChange={(e) => set("bidContactName")(e.target.value)} />
          </Field>
          <Field label="Title">
            <input className={INPUT} value={p.bidContactTitle} onChange={(e) => set("bidContactTitle")(e.target.value)} />
          </Field>
          <Field label="Email">
            <input className={INPUT} value={p.bidContactEmail} onChange={(e) => set("bidContactEmail")(e.target.value)} />
          </Field>
          <Field label="Phone">
            <input className={INPUT} value={p.bidContactPhone} onChange={(e) => set("bidContactPhone")(e.target.value)} />
          </Field>
        </div>
      </Section>

      {/* Save bar — sticky so it's reachable from any section on a long form. */}
      <div className="sticky bottom-0 -mx-6 flex items-center gap-3 border-t border-border bg-background/90 px-6 py-3 backdrop-blur sm:-mx-8 sm:px-8">
        <button
          onClick={save}
          disabled={saving}
          className="btn-hero inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium disabled:opacity-50"
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
          {saving ? "Saving…" : "Save profile"}
        </button>
        {error && <span className="text-sm text-red-400">{error}</span>}
        {!error && savedAt && (
          <span className="text-sm text-emerald-300">
            Saved {new Date(savedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
          </span>
        )}
      </div>
    </main>
  );
}
