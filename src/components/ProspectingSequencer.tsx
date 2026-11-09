"use client";

// Radar outreach: the cold email tool connection (Instantly or Smartlead), the review and approve step
// before any lead is handed to it, and the shared do-not-contact list. Nothing is pushed without a person
// ticking the leads and pressing Approve. API keys are write only (never shown back).

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

const btn = "inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[12px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50";
const input = "w-full rounded border border-border bg-transparent px-2 py-1 text-[12.5px] text-foreground placeholder:text-meta";

type Provider = "instantly" | "smartlead";
const LABEL: Record<Provider, string> = { instantly: "Instantly", smartlead: "Smartlead" };

interface ProviderState {
  provider: Provider;
  providers: Record<Provider, { keySet: boolean; campaignId: string | null }>;
  mailingAddress: string;
  connected: boolean;
  unsupportedProvider: string | null;
  probe?: { ok: boolean; campaignName?: string; status?: string; error?: string } | null;
}

const HELP: Record<Provider, { key: string; campaign: string; placeholder: string; steps: string }> = {
  instantly: {
    key: "Instantly API key (Settings → Integrations → API keys; leads and campaigns scopes)",
    campaign: "Campaign id (the long id in the campaign URL)",
    placeholder: "e.g. 1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
    steps: "In the Instantly campaign, put {{intro_subject}} as the step 1 subject and {{intro_body}} as the step 1 body (the body already ends with the footer above). Turn on Stop on reply, keep the unsubscribe link, and send only from the warmed outreach inboxes, never zoeeventsdmv.com.",
  },
  smartlead: {
    key: "Smartlead API key (Pro plan or higher)",
    campaign: "Campaign id (the number in the campaign URL)",
    placeholder: "e.g. 1234567",
    steps: "In the Smartlead campaign, use {{intro_subject}} and {{intro_body}} in the first email (the body already ends with the footer above), and keep Smartlead's unsubscribe link on. Send from a separate warmed domain, never zoeeventsdmv.com.",
  },
};

export function SequencerSettings() {
  const router = useRouter();
  const [st, setSt] = useState<ProviderState | null>(null);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<Provider>("instantly");
  const [apiKey, setApiKey] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [mailing, setMailing] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/prospecting/provider")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ProviderState | null) => {
        if (!d) return;
        setSt(d);
        setSel(d.provider);
        setCampaignId(d.providers[d.provider]?.campaignId ?? "");
        setMailing(d.mailingAddress);
      })
      .catch(() => {});
  }, []);

  if (!st) return null;

  function pick(p: Provider) {
    setSel(p);
    setApiKey("");
    setCampaignId(st?.providers[p]?.campaignId ?? "");
  }

  async function save() {
    setBusy(true);
    try {
      const res = await fetch("/api/prospecting/provider", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: sel, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), campaignId, mailingAddress: mailing }),
      });
      const d = (await res.json()) as ProviderState & { error?: string };
      if (!res.ok) throw new Error(d.error || "Save failed");
      setSt(d);
      setApiKey("");
      if (d.probe && !d.probe.ok) toast.error(`Saved, but ${LABEL[sel]} said: ${d.probe.error}`);
      else if (d.probe?.ok) toast.success(`Connected to ${LABEL[sel]} campaign "${d.probe.campaignName ?? campaignId}"${d.probe.status ? ` (${d.probe.status})` : ""}`);
      else toast.success(`Saved. Outreach now goes to ${LABEL[sel]}.`);
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const cur = st.providers[sel];
  const help = HELP[sel];
  return (
    <section className="mb-4 rounded border border-border p-3">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <span className="font-medium text-foreground">Cold email: {LABEL[st.provider]}</span>
        <span className={st.connected ? "text-positive" : "text-meta"}>{st.connected ? "connected" : st.unsupportedProvider ? `SEQUENCER_PROVIDER=${st.unsupportedProvider} is not supported` : "not connected (CSV export only)"}</span>
        <button className={`${btn} ml-auto`} onClick={() => setOpen((o) => !o)}>{open ? "Close" : "Settings"}</button>
      </div>
      {open && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div className="flex flex-wrap items-center gap-3 text-[12px] sm:col-span-2" role="radiogroup" aria-label="Cold email tool">
            <span className="text-[11.5px] text-meta">Tool</span>
            {(Object.keys(LABEL) as Provider[]).map((p) => (
              <label key={p} className="inline-flex items-center gap-1.5 text-foreground">
                <input type="radio" name="sequencer-provider" checked={sel === p} onChange={() => pick(p)} />
                {LABEL[p]}
                <span className="text-[11px] text-meta">{st.providers[p]?.keySet && st.providers[p]?.campaignId ? "set up" : "not set up"}</span>
              </label>
            ))}
          </div>
          <label className="text-[11.5px] text-meta">{help.key} {cur?.keySet ? "(set; leave blank to keep)" : ""}
            <input type="password" autoComplete="off" className={input} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={cur?.keySet ? "••••••••" : `${LABEL[sel]} API key`} />
          </label>
          <label className="text-[11.5px] text-meta">{help.campaign}
            <input className={input} inputMode={sel === "smartlead" ? "numeric" : "text"} value={campaignId} onChange={(e) => setCampaignId(e.target.value)} placeholder={help.placeholder} />
          </label>
          <label className="text-[11.5px] text-meta sm:col-span-2">Postal mailing address for the email footer (required by CAN-SPAM)
            <input className={input} value={mailing} onChange={(e) => setMailing(e.target.value)} />
          </label>
          <p className="text-[11.5px] text-meta sm:col-span-2">{help.steps}</p>
          <div className="sm:col-span-2">
            <button className={btn} disabled={busy} onClick={save}>{busy ? "Saving…" : sel === st.provider ? "Save and test" : `Switch to ${LABEL[sel]} and test`}</button>
          </div>
        </div>
      )}
    </section>
  );
}

interface Candidate {
  enrollmentId: string;
  opportunityId: string;
  opportunityName: string;
  company: string;
  email: string | null;
  subject: string;
  body: string;
  dueAt: string;
  eligible: boolean;
  blockers: string[];
  check?: string;
  checkLabel?: string;
}

export function SequencerPushReview() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [tool, setTool] = useState("the email tool");
  const [rows, setRows] = useState<Candidate[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/prospecting/push");
      const d = (await res.json()) as { connected?: boolean; provider?: string; candidates?: Candidate[]; error?: string };
      if (!res.ok) throw new Error(d.error || "Could not load");
      setConnected(Boolean(d.connected));
      if (d.provider) setTool(d.provider);
      setRows(d.candidates ?? []);
      setPicked(new Set((d.candidates ?? []).filter((c) => c.eligible).map((c) => c.enrollmentId)));
      setOpen(true);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function approve() {
    if (picked.size === 0) return;
    setBusy(true);
    try {
      const res = await fetch("/api/prospecting/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enrollmentIds: [...picked] }) });
      const d = (await res.json()) as { provider?: string; added?: number; skipped?: { reason: string }[]; errors?: string[]; error?: string };
      if (d.error) throw new Error(d.error);
      const to = d.provider ?? tool;
      const skipped = d.skipped?.length ?? 0;
      if (d.errors?.length) toast.error(`${d.added ?? 0} handed to ${to}, ${skipped} not. ${d.errors[0]}`);
      else toast.success(`${d.added ?? 0} handed to ${to}${skipped ? `, ${skipped} skipped` : ""}`);
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div>
      <button className={btn} onClick={open ? () => setOpen(false) : load} disabled={loading}>{loading ? "Loading…" : open ? "Close review" : "Review email push"}</button>
      {open && (
        <div className="mt-2 rounded border border-border">
          {!connected && <p className="border-b border-border px-3 py-2 text-[12px] text-attention">{tool} is not connected yet. Open Settings above to add the key and campaign.</p>}
          {rows.length === 0 ? (
            <p className="px-3 py-3 text-[12.5px] text-meta">No Tier B leads are due to hand off.</p>
          ) : (
            <>
              {rows.map((c) => (
                <div key={c.enrollmentId} className="border-t border-[var(--row-rule)] px-3 py-2 first:border-t-0">
                  <label className="flex items-start gap-2 text-[12.5px]">
                    <input type="checkbox" className="mt-1" disabled={!c.eligible} checked={picked.has(c.enrollmentId)} onChange={() => toggle(c.enrollmentId)} />
                    <span className="min-w-0">
                      <span className="text-foreground">{c.company || "Unknown company"}</span>
                      <span className="text-meta"> · {c.email ?? "no email"} · {c.opportunityName}</span>
                      {!c.eligible && <span className="block text-[11.5px] text-critical">Can&apos;t send: {c.blockers.join("; ")}</span>}
                      {c.eligible && c.check && (
                        <span className={`block text-[11.5px] ${c.check === "valid" ? "text-positive" : "text-attention"}`}>
                          {c.check === "valid" ? "Email verified" : "Email gets checked when you approve; only a good address is sent"}
                        </span>
                      )}
                    </span>
                  </label>
                  <details className="ml-6 mt-1 text-[12px] text-meta">
                    <summary className="cursor-pointer text-tertiary-text">First email · {c.subject}</summary>
                    <p className="mt-1 whitespace-pre-wrap text-tertiary-text">{c.body}</p>
                  </details>
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
                <span className="text-[12px] text-meta">{picked.size} selected. Each email is checked first (Instantly verifier); {tool} sends from its campaign and you can pause it there.</span>
                <button className={`${btn} ml-auto`} disabled={busy || picked.size === 0 || !connected} onClick={approve}>{busy ? "Pushing…" : `Approve and push ${picked.size}`}</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface Suppression { id: string; kind: string; value: string; reason: string | null; createdBy: string | null; createdAt: string }

export function DoNotContactList({ canRemove }: { canRemove: boolean }) {
  const [rows, setRows] = useState<Suppression[] | null>(null);
  const [kind, setKind] = useState("email");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);

  const load = () => fetch("/api/prospecting/suppress").then((r) => r.json()).then((d: { entries?: Suppression[] }) => setRows(d.entries ?? [])).catch(() => setRows([]));
  useEffect(() => { if (open && rows === null) void load(); }, [open, rows]);

  async function add() {
    if (!value.trim()) return;
    const res = await fetch("/api/prospecting/suppress", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, value, reason }) });
    const d = (await res.json()) as { error?: string };
    if (!res.ok) { toast.error(d.error || "Could not add"); return; }
    setValue(""); setReason("");
    toast.success("Added to do-not-contact");
    void load();
  }
  async function remove(id: string) {
    const res = await fetch(`/api/prospecting/suppress?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) { toast.error("Could not remove"); return; }
    void load();
  }

  return (
    <section className="mt-8">
      <button className="text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text hover:text-foreground" onClick={() => setOpen((o) => !o)}>
        Do-not-contact list {rows ? `· ${rows.length}` : ""} {open ? "▴" : "▾"}
      </button>
      {open && (
        <div className="mt-2 rounded border border-border p-3">
          <p className="mb-2 text-[11.5px] text-meta">Shared by Radar outreach and Sales OS texts. Bounces, &quot;not interested&quot; outcomes and texted STOP replies are added automatically.</p>
          <div className="mb-3 flex flex-wrap gap-2">
            <select className="rounded border border-border bg-transparent px-2 py-1 text-[12.5px]" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="email">Email</option><option value="domain">Domain</option><option value="company">Company</option><option value="phone">Phone</option>
            </select>
            <input className={`${input} min-w-[180px] flex-1`} value={value} onChange={(e) => setValue(e.target.value)} placeholder="value" />
            <input className={`${input} min-w-[140px] flex-1`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="reason (optional)" />
            <button className={btn} onClick={add}>Add</button>
          </div>
          {rows === null ? <p className="text-[12px] text-meta">Loading…</p> : rows.length === 0 ? <p className="text-[12px] text-meta">Empty.</p> : (
            <ul className="divide-y divide-[var(--row-rule)] text-[12.5px]">
              {rows.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2 py-1.5">
                  <span className="rounded border border-border px-1.5 text-[10.5px] uppercase text-tertiary-text">{r.kind}</span>
                  <span className="min-w-0 break-all text-foreground">{r.value}</span>
                  <span className="text-meta">{r.reason ?? ""}{r.createdBy ? ` · ${r.createdBy}` : ""} · {r.createdAt.slice(0, 10)}</span>
                  {canRemove && <button className="ml-auto text-[11.5px] text-meta hover:text-critical" onClick={() => remove(r.id)}>Remove</button>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
