"use client";

// Bulk Review-and-Fire panel — the Quote-Sent cohort in one table. Each row shows the quote facts, the
// last touch, and the refreshed SMS + email drafts, with per-channel include checkboxes. The owner
// selects (select-all / clear-all + per-row), sees a live "N selected, M SMS, K email" count, and clicks
// "Queue approved for send". That fires each selection through the governed approval path on the server
// (email_send outbox op / held SMS). Post-fire the panel reflects the REAL per-channel outcome (queued /
// held / duplicate / failed) returned by the server — never a bare "sent". Nothing sends without the click.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Mail, MessageSquare, Send, AlertTriangle, Clock } from "lucide-react";
import type { BulkOutreachCohort, BulkOutreachRow, BulkQueueSummary } from "@/lib/salesos/bulkOutreach";

const money = (n: number | null): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));

interface Sel {
  sms: boolean;
  email: boolean;
}

type RowOutcome = { email?: { status: string; message: string }; sms?: { status: string; message: string }; skipped?: { channel: string; reason: string }[] };

const outcomeTone = (status: string): string => {
  if (status === "queued") return "text-positive";
  if (status === "failed") return "text-critical";
  return "text-attention"; // approved (held / gate off), etc.
};

export function BulkOutreachPanel({ cohort, showMoney }: { cohort: BulkOutreachCohort; showMoney: boolean }): React.JSX.Element {
  const router = useRouter();
  const [sel, setSel] = useState<Record<string, Sel>>(() => {
    const init: Record<string, Sel> = {};
    for (const r of cohort.rows) init[r.leadId] = { sms: r.defaultSms, email: r.defaultEmail };
    return init;
  });
  const [working, setWorking] = useState(false);
  const [results, setResults] = useState<Record<string, RowOutcome>>({});
  const [summary, setSummary] = useState<BulkQueueSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const counts = useMemo(() => {
    let rowsSel = 0;
    let smsN = 0;
    let emailN = 0;
    for (const r of cohort.rows) {
      const s = sel[r.leadId];
      if (!s) continue;
      const sms = s.sms && r.smsAvailable;
      const email = s.email && r.emailAvailable;
      if (sms || email) rowsSel++;
      if (sms) smsN++;
      if (email) emailN++;
    }
    return { rowsSel, smsN, emailN };
  }, [sel, cohort.rows]);

  const setRow = (id: string, patch: Partial<Sel>): void => setSel((p) => ({ ...p, [id]: { ...p[id], ...patch } }));

  const selectAll = (): void => {
    const next: Record<string, Sel> = {};
    for (const r of cohort.rows) next[r.leadId] = { sms: r.smsAvailable && !r.draftFailed, email: r.emailAvailable && !r.draftFailed };
    setSel(next);
  };
  const clearAll = (): void => {
    const next: Record<string, Sel> = {};
    for (const r of cohort.rows) next[r.leadId] = { sms: false, email: false };
    setSel(next);
  };

  const queue = async (): Promise<void> => {
    setWorking(true);
    setError(null);
    const items = cohort.rows
      .map((r) => {
        const s = sel[r.leadId];
        if (!s) return null;
        const email = s.email && r.emailAvailable && r.emailDraft ? { subject: r.emailSubject, body: r.emailDraft } : undefined;
        const sms = s.sms && r.smsAvailable && r.smsDraft ? { body: r.smsDraft } : undefined;
        if (!email && !sms) return null;
        return { leadId: r.leadId, clientName: r.clientName, value: r.value, eventDate: r.eventDate, email, sms };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    if (items.length === 0) {
      setError("Nothing selected to queue.");
      setWorking(false);
      return;
    }

    try {
      const res = await fetch("/api/salesos/bulk-outreach", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items }) });
      const j = (await res.json()) as { ok?: boolean; summary?: BulkQueueSummary; error?: string };
      if (!j.ok || !j.summary) {
        setError(j.error ?? "Failed to queue.");
        setWorking(false);
        return;
      }
      const byRow: Record<string, RowOutcome> = {};
      for (const row of j.summary.rows) {
        const o: RowOutcome = {};
        for (const c of row.channels) {
          if (c.channel === "email") o.email = { status: c.status, message: c.message };
          else o.sms = { status: c.status, message: c.message };
        }
        if (row.skipped.length) o.skipped = row.skipped;
        byRow[row.leadId] = o;
      }
      setResults(byRow);
      setSummary(j.summary);
      router.refresh();
    } catch {
      setError("Failed to queue.");
    } finally {
      setWorking(false);
    }
  };

  return (
    <main className="min-w-0 flex-1 p-6">
      <header className="mb-4">
        <h1 className="text-[22px] font-medium tracking-tight">Bulk Review &amp; Fire — Quote Sent</h1>
        <p className="text-[12.5px] text-meta">
          Every lead in the Quote Sent column with a refreshed next-step draft. Select rows and channels, then approve. Approval queues each one through the governed outbox (email) or records it as a held decision (text); nothing sends without your click.
        </p>
      </header>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border border-border bg-panel px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={selectAll} className="border border-border bg-[var(--row)] px-3 py-1.5 text-[12.5px] hover:bg-[var(--row-hover)]">Select all</button>
          <button onClick={clearAll} className="border border-border bg-[var(--row)] px-3 py-1.5 text-[12.5px] hover:bg-[var(--row-hover)]">Clear all</button>
          <span className="ml-1 text-[12.5px] text-tertiary-text">
            {counts.rowsSel} selected, {counts.smsN} will send SMS, {counts.emailN} will send email.
          </span>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-meta">
          <span>Email send: <span className={cohort.emailGateOn ? "text-positive" : "text-attention"}>{cohort.emailGateOn ? "on" : "off"}</span></span>
          <span>SMS send: <span className={cohort.smsGateOn ? "text-positive" : "text-attention"}>{cohort.smsGateOn ? "on" : "off"}</span></span>
          <button
            onClick={queue}
            disabled={working || counts.rowsSel === 0}
            className="flex items-center gap-1.5 border border-border bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background hover:opacity-90 disabled:opacity-40"
          >
            <Send className="size-3.5" /> {working ? "Queuing…" : "Queue approved for send"}
          </button>
        </div>
      </div>

      {!cohort.emailGateOn && (
        <p className="mb-3 flex items-start gap-1.5 border border-border px-3 py-2 text-[12px] text-attention">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> EMAIL_SEND_ENABLED is off. Approved emails are recorded and held, not sent, until the gate is turned on.
        </p>
      )}
      {error && <p className="mb-3 border border-border px-3 py-2 text-[12px] text-critical">{error}</p>}
      {summary && (
        <p className="mb-3 border border-border px-3 py-2 text-[12px] text-positive">
          Queued {summary.queuedEmail} email{summary.queuedEmail === 1 ? "" : "s"} to the outbox, held {summary.heldSms} text{summary.heldSms === 1 ? "" : "s"} and {summary.heldEmail} gated email{summary.heldEmail === 1 ? "" : "s"}
          {summary.duplicates ? `, ${summary.duplicates} already queued today` : ""}
          {summary.failed ? `, ${summary.failed} failed` : ""}. Nothing is confirmed delivered until the office sync reports it landed.
        </p>
      )}

      {cohort.rows.length === 0 ? (
        <p className="border border-border px-3 py-16 text-center text-[13.5px] text-muted-foreground">No leads in the Quote Sent column.</p>
      ) : (
        <div className="overflow-x-auto border border-border">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-border bg-background text-left text-[11px] uppercase tracking-[0.1em] text-tertiary-text">
                <th className="px-3 py-2 font-medium">Customer</th>
                {showMoney && <th className="px-3 py-2 text-right font-medium">Quote</th>}
                <th className="px-3 py-2 font-medium">Sent</th>
                <th className="px-3 py-2 font-medium">Last touch</th>
                <th className="px-3 py-2 font-medium">Text</th>
                <th className="px-3 py-2 font-medium">Email</th>
              </tr>
            </thead>
            <tbody>
              {cohort.rows.map((r) => (
                <Row key={r.leadId} r={r} showMoney={showMoney} sel={sel[r.leadId]} setRow={setRow} result={results[r.leadId]} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function Row({
  r,
  showMoney,
  sel,
  setRow,
  result,
}: {
  r: BulkOutreachRow;
  showMoney: boolean;
  sel: Sel | undefined;
  setRow: (id: string, patch: Partial<Sel>) => void;
  result: RowOutcome | undefined;
}): React.JSX.Element {
  return (
    <tr className="border-b border-[var(--row-rule)] align-top">
      <td className="px-3 py-2.5">
        <div className="font-medium text-foreground">{r.clientName || "Unknown client"}</div>
        <div className="truncate text-[12px] text-meta" title={r.eventName}>{r.eventName || `Project ${r.leadId}`}</div>
        {r.note && (
          <div className="mt-1 flex items-start gap-1 text-[11px] text-attention">
            {r.recentlyContacted ? <Clock className="mt-0.5 size-3 shrink-0" /> : <AlertTriangle className="mt-0.5 size-3 shrink-0" />}
            {r.note}
          </div>
        )}
      </td>
      {showMoney && <td className="px-3 py-2.5 text-right tabular-nums">{money(r.value)}</td>}
      <td className="px-3 py-2.5 text-[12px] text-tertiary-text">
        <div>{r.quoteSentDate ?? "—"}</div>
        {r.daysSinceQuote != null && <div className="text-meta">{r.daysSinceQuote}d ago</div>}
      </td>
      <td className="px-3 py-2.5 text-[12px] text-tertiary-text">
        {r.lastTouch ? (
          <>
            <div>{r.lastTouch.what}</div>
            <div className="text-meta">{r.lastTouch.when}</div>
          </>
        ) : (
          <span className="text-meta">none logged</span>
        )}
      </td>

      {/* Text channel */}
      <td className="px-3 py-2.5">
        <ChannelCell
          icon={<MessageSquare className="size-3.5" />}
          available={r.smsAvailable}
          unavailableLabel="No phone"
          checked={!!sel?.sms && r.smsAvailable}
          disabled={!r.smsAvailable || r.draftFailed}
          onToggle={(v) => setRow(r.leadId, { sms: v })}
          preview={r.smsDraft}
          result={result?.sms}
        />
      </td>

      {/* Email channel */}
      <td className="px-3 py-2.5">
        <ChannelCell
          icon={<Mail className="size-3.5" />}
          available={r.emailAvailable}
          unavailableLabel="No email"
          checked={!!sel?.email && r.emailAvailable}
          disabled={!r.emailAvailable || r.draftFailed}
          onToggle={(v) => setRow(r.leadId, { email: v })}
          preview={r.emailDraft}
          subject={r.emailSubject}
          result={result?.email}
        />
      </td>
    </tr>
  );
}

function ChannelCell({
  icon,
  available,
  unavailableLabel,
  checked,
  disabled,
  onToggle,
  preview,
  subject,
  result,
}: {
  icon: React.ReactNode;
  available: boolean;
  unavailableLabel: string;
  checked: boolean;
  disabled: boolean;
  onToggle: (v: boolean) => void;
  preview: string | null;
  subject?: string;
  result?: { status: string; message: string };
}): React.JSX.Element {
  if (!available) return <span className="text-[12px] text-meta">{unavailableLabel}</span>;
  if (!preview) return <span className="text-[12px] text-meta">no draft</span>;
  return (
    <div className="min-w-[220px] max-w-[320px]">
      <label className="flex items-center gap-1.5 text-[12px] text-tertiary-text">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onToggle(e.target.checked)} className="size-3.5 accent-[var(--accent,currentColor)]" />
        {icon}
        <span>include</span>
      </label>
      {subject && <div className="mt-1 text-[11px] font-medium text-tertiary-text">Subject: {subject}</div>}
      <p className="mt-1 whitespace-pre-wrap text-[12px] leading-snug text-meta">{preview}</p>
      {result && <div className={`mt-1 text-[11px] ${outcomeTone(result.status)}`}>{result.status}: {result.message}</div>}
    </div>
  );
}
