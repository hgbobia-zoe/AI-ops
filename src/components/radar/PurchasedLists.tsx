"use client";

// Purchased contact lists (Radar → Lists): import a bought list, approve a push to the cold email tool,
// edit the list's details, and log replies. Nothing is emailed without a person pressing Approve.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

const btn = "inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[12px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50";
const input = "w-full rounded border border-border bg-transparent px-2 py-1 text-[12.5px] text-foreground placeholder:text-meta";
const label = "text-[11.5px] text-meta";

export const SEGMENTS: { value: string; label: string }[] = [
  { value: "venue", label: "Venues" },
  { value: "planner", label: "Event planners" },
  { value: "corporate", label: "Corporate / office managers" },
  { value: "association", label: "Associations and nonprofits" },
  { value: "other", label: "Other" },
];

interface ImportResponse {
  error?: string;
  list?: { id: string; name: string };
  rows?: number;
  imported?: number;
  missingEmail?: number;
  invalidEmail?: number;
  duplicatesInFile?: number;
  source?: "google_maps" | "generic";
}

export function ListImport({ template }: { template: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [segment, setSegment] = useState("venue");
  const [vendor, setVendor] = useState("");
  const [cost, setCost] = useState("");
  const [purchasedAt, setPurchasedAt] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);

  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([template], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = "zoe-contact-list-template.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  async function onFile(f: File | undefined) {
    if (!f) return;
    if (f.size > 15 * 1024 * 1024) { toast.error("That file is over 15 MB; split it first"); return; }
    setFileName(f.name);
    setCsv(await f.text());
    if (!name) setName(f.name.replace(/\.csv$/i, ""));
  }

  async function submit() {
    setBusy(true);
    try {
      const res = await fetch("/api/radar/lists", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, segment, vendor, cost, purchasedAt, campaignId, csv }),
      });
      const d = (await res.json()) as ImportResponse;
      if (!res.ok || !d.list) throw new Error(d.error || "Import failed");
      const maps = d.source === "google_maps";
      const dropped = [
        d.duplicatesInFile ? `${d.duplicatesInFile} repeated` : "",
        d.missingEmail ? `${d.missingEmail} ${maps ? "places " : ""}with no email` : "",
        d.invalidEmail ? `${d.invalidEmail} with a bad email` : "",
      ].filter(Boolean).join(", ");
      toast.success(`Imported ${d.imported} contacts${maps ? " from the Google Maps export" : ""}${dropped ? ` (left out: ${dropped})` : ""}`);
      router.push(`/radar/lists/${d.list.id}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) return <button className={btn} onClick={() => setOpen(true)}>Import a list</button>;
  return (
    <section className="rounded border border-border p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium text-foreground">Import a purchased list</span>
        <button className={`${btn} ml-auto`} onClick={downloadTemplate}>Download template</button>
        <button className={btn} onClick={() => setOpen(false)}>Close</button>
      </div>
      <p className="mb-3 text-[11.5px] text-meta">
        A CSV from Apollo, ZoomInfo, a list broker or Apify&apos;s Google Maps Scraper works as is. Only an email column is required; first and last name, title, company, website, phone, city and state are picked up when present. For Google Maps, run it with the &quot;Company contacts enrichment&quot; add-on so places come with emails. Nothing is emailed until you review and approve a push.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className={label}>List name
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. DMV venues, Apollo, Nov 2026" />
        </label>
        <label className={label}>Who is on it
          <select className={input} value={segment} onChange={(e) => setSegment(e.target.value)}>
            {SEGMENTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
        <label className={label}>Bought from (optional)
          <input className={input} value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Apollo, Apify Google Maps, a broker…" />
        </label>
        <label className={label}>What it cost, in dollars (optional; used for cost per lead)
          <input className={input} inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="e.g. 249" />
        </label>
        <label className={label}>Purchase date (optional)
          <input type="date" className={input} value={purchasedAt} onChange={(e) => setPurchasedAt(e.target.value)} />
        </label>
        <label className={label}>Campaign id for this list (optional; else the default campaign)
          <input className={input} value={campaignId} onChange={(e) => setCampaignId(e.target.value)} placeholder="from the campaign URL" />
        </label>
        <label className={`${label} sm:col-span-2`}>File
          <input type="file" accept=".csv,text/csv" className="block text-[12px] text-tertiary-text" onChange={(e) => void onFile(e.target.files?.[0])} />
        </label>
        <label className={`${label} sm:col-span-2`}>…or paste the rows (with the header row) {fileName && <span className="text-tertiary-text">· loaded {fileName}</span>}
          <textarea className={`${input} h-28 font-mono text-[11.5px]`} value={csv} onChange={(e) => { setCsv(e.target.value); setFileName(""); }} placeholder={template} />
        </label>
      </div>
      <div className="mt-3"><button className={btn} disabled={busy || !csv.trim() || !name.trim()} onClick={submit}>{busy ? "Importing…" : "Import list"}</button></div>
    </section>
  );
}

interface VerifyResponse {
  ok?: boolean; error?: string; checked?: number; remaining?: number; stopped?: string | null; errors?: string[];
  counts?: { valid: number; catch_all: number; invalid: number; no_mail_server: number; pending: number };
  creditsLeft?: number | null;
}

/** Check every waiting address before anything can be sent: free domain check, then Instantly's verifier.
 *  Runs batch after batch until done, stopped (key, credits, rate limit) or only pending answers remain. */
export function ListVerifyPanel({ listId, toCheck, hasKey }: { listId: string; toCheck: number; hasKey: boolean }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");

  async function run() {
    setBusy(true);
    const tally = { checked: 0, valid: 0, catch_all: 0, bad: 0, pending: 0 };
    let credits: number | null = null;
    let waits = 0;
    try {
      for (let round = 0; round < 300; round++) {
        const res = await fetch(`/api/radar/lists/${listId}/verify`, { method: "POST" });
        const d = (await res.json()) as VerifyResponse;
        if (!res.ok || d.error) throw new Error(d.error || "Check failed");
        const c = d.counts ?? { valid: 0, catch_all: 0, invalid: 0, no_mail_server: 0, pending: 0 };
        tally.checked += (d.checked ?? 0) - c.pending;
        tally.valid += c.valid; tally.catch_all += c.catch_all; tally.bad += c.invalid + c.no_mail_server; tally.pending = c.pending;
        if (d.creditsLeft != null) credits = d.creditsLeft;
        setProgress(`Checked ${tally.checked} · ${tally.valid} good · ${tally.bad} would bounce · ${tally.catch_all} catch-all${d.remaining ? ` · ${d.remaining} to go` : ""}`);
        if (d.stopped) { toast.error(`Stopped: ${d.stopped}`); break; }
        if (!d.checked && d.errors?.length) { toast.error(d.errors[0]); break; }
        if (!d.remaining) { toast.success(`Emails checked: ${tally.valid} good, ${tally.bad} would bounce, ${tally.catch_all} catch-all`); break; }
        // No final answer this round: Instantly is still working on the pending ones. Wait, then collect.
        if ((d.checked ?? 0) - c.pending <= 0) {
          if (++waits > 10) { toast.message(`${d.remaining} still being checked by Instantly. Click again in a few minutes.`); break; }
          await new Promise((r) => setTimeout(r, 8000));
        }
      }
      if (credits != null) setProgress((p) => `${p} · ${credits} Instantly credits left`);
      setConfirming(false);
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-3 rounded border border-border p-3 text-[12.5px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">Check emails</span>
        <span className="text-meta">
          Nothing goes into a campaign until its email passed. A free check removes domains that can&apos;t get mail, then Instantly verifies the rest (1 credit each). Results are kept, so nobody is checked twice.
        </span>
      </div>
      {!hasKey && <p className="mt-1 text-attention">Add the Instantly API key in Radar → Outreach → Cold email settings to verify. Without it only the free domain check runs.</p>}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {progress && <span className="text-tertiary-text">{progress}</span>}
        {!confirming ? (
          <button className={`${btn} ml-auto`} disabled={toCheck === 0 || busy} onClick={() => setConfirming(true)}>
            {toCheck === 0 ? "All emails checked" : `Check ${toCheck} ${toCheck === 1 ? "email" : "emails"}`}
          </button>
        ) : (
          <span className="ml-auto inline-flex flex-wrap items-center gap-2">
            <span className="text-attention">Check {toCheck === 1 ? "1 email" : `${toCheck} emails`}? Uses up to {toCheck} Instantly verification {toCheck === 1 ? "credit" : "credits"}.</span>
            <button className={btn} disabled={busy} onClick={run}>{busy ? "Checking…" : "Yes, check them"}</button>
            <button className={btn} disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
          </span>
        )}
      </div>
    </section>
  );
}

interface PushResponse { provider?: string; added?: number; skipped?: { email: string; reason: string }[]; errors?: string[]; error?: string }

export function ListPushPanel({ listId, ready, provider, connected, campaignLabel, maxPush }: { listId: string; ready: number; provider: string; connected: boolean; campaignLabel: string; maxPush: number }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const count = Math.min(ready, maxPush);

  async function push() {
    setBusy(true);
    try {
      const res = await fetch(`/api/radar/lists/${listId}/push`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ allReady: true }) });
      const d = (await res.json()) as PushResponse;
      if (d.error) throw new Error(d.error);
      const skipped = d.skipped?.length ?? 0;
      if (d.errors?.length) toast.error(`${d.added ?? 0} sent to ${d.provider ?? provider}, ${skipped} not. ${d.errors[0]}`);
      else toast.success(`${d.added ?? 0} sent to ${d.provider ?? provider}${skipped ? `, ${skipped} skipped` : ""}`);
      setConfirming(false);
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-4 rounded border border-border p-3 text-[12.5px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">Send to {provider}</span>
        <span className={connected ? "text-meta" : "text-attention"}>{connected ? campaignLabel : `${provider} is not connected yet. Set it up in Radar → Outreach → Cold email settings.`}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <span className="text-tertiary-text">Only contacts whose email passed the check are sent.</span>
        {!confirming ? (
          <button className={`${btn} ml-auto`} disabled={!connected || count === 0} onClick={() => setConfirming(true)}>
            {count === 0 ? "Nobody ready to send" : `Review and send ${count}`}
          </button>
        ) : (
          <span className="ml-auto inline-flex flex-wrap items-center gap-2">
            <span className="text-attention">
              Send {count} contacts{ready > maxPush ? ` (of ${ready} ready; ${maxPush} max per push)` : ""} to {provider}? They start getting emails when the campaign is running.
            </span>
            <button className={btn} disabled={busy} onClick={push}>{busy ? "Sending…" : "Approve and send"}</button>
            <button className={btn} disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
          </span>
        )}
      </div>
    </section>
  );
}

interface ListFields { id: string; name: string; segment: string; vendor: string | null; cost: number | null; purchasedAt: string | null; campaignId: string | null; notes: string | null; includeCatchAll: boolean }

export function ListSettings({ list, canDelete }: { list: ListFields; canDelete: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: list.name, segment: list.segment, vendor: list.vendor ?? "", cost: list.cost == null ? "" : String(list.cost), purchasedAt: list.purchasedAt ?? "", campaignId: list.campaignId ?? "", notes: list.notes ?? "" });
  const [catchAll, setCatchAll] = useState(list.includeCatchAll);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  async function save() {
    setBusy(true);
    try {
      const res = await fetch(`/api/radar/lists/${list.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...f, includeCatchAll: catchAll }) });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(d.error || "Save failed");
      toast.success("Saved");
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!window.confirm(`Delete the list "${list.name}" and its contacts? Nobody on it has been emailed.`)) return;
    const res = await fetch(`/api/radar/lists/${list.id}`, { method: "DELETE" });
    const d = (await res.json()) as { error?: string };
    if (!res.ok) { toast.error(d.error || "Could not delete"); return; }
    toast.success("List deleted");
    router.push("/radar/lists");
  }

  if (!open) return <button className={btn} onClick={() => setOpen(true)}>Edit list</button>;
  return (
    <section className="mb-4 grid gap-2 rounded border border-border p-3 sm:grid-cols-2">
      <label className={label}>Name<input className={input} value={f.name} onChange={set("name")} /></label>
      <label className={label}>Who is on it
        <select className={input} value={f.segment} onChange={set("segment")}>{SEGMENTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select>
      </label>
      <label className={label}>Bought from<input className={input} value={f.vendor} onChange={set("vendor")} /></label>
      <label className={label}>Cost (dollars)<input className={input} inputMode="decimal" value={f.cost} onChange={set("cost")} /></label>
      <label className={label}>Purchase date<input type="date" className={input} value={f.purchasedAt} onChange={set("purchasedAt")} /></label>
      <label className={label}>Campaign id (blank = the default campaign)<input className={input} value={f.campaignId} onChange={set("campaignId")} /></label>
      <label className={`${label} sm:col-span-2`}>Notes<textarea className={`${input} h-16`} value={f.notes} onChange={set("notes")} /></label>
      <label className="inline-flex items-start gap-1.5 text-[12px] text-tertiary-text sm:col-span-2">
        <input type="checkbox" className="mt-0.5" checked={catchAll} onChange={(e) => setCatchAll(e.target.checked)} />
        Also send to catch-all addresses. Their domain accepts any address, so the check can&apos;t confirm the person exists; some will bounce. Leave off unless the list runs short.
      </label>
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <button className={btn} disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
        <button className={btn} onClick={() => setOpen(false)}>Cancel</button>
        {canDelete && <button className={`${btn} ml-auto hover:text-critical`} onClick={remove}>Delete list</button>}
      </div>
    </section>
  );
}

const OUTCOMES: { value: string; label: string }[] = [
  { value: "replied", label: "Replied" },
  { value: "interested", label: "Interested → Radar opportunity" },
  { value: "not_interested", label: "Not interested" },
  { value: "bounced", label: "Bounced" },
  { value: "unsubscribed", label: "Unsubscribed" },
];

export function ListContactOutcome({ contactId }: { contactId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function log(outcome: string) {
    if (!outcome) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/radar/lists/contacts/${contactId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ outcome }) });
      const d = (await res.json()) as { error?: string; opportunityId?: string | null };
      if (!res.ok) throw new Error(d.error || "Could not save");
      toast.success(outcome === "interested" ? "Logged. A Radar opportunity is ready to work." : outcome === "replied" ? "Logged" : "Logged and added to do-not-contact");
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <select aria-label="Log a reply" className="rounded border border-border bg-transparent px-1.5 py-0.5 text-[11.5px] text-tertiary-text" disabled={busy} value="" onChange={(e) => void log(e.target.value)}>
      <option value="">Log reply…</option>
      {OUTCOMES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}
