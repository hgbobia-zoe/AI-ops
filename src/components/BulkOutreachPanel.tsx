"use client";

// Bulk Review-and-Fire panel — the Quote-Sent cohort in one table. Each row shows the quote facts, the
// last touch, and the refreshed SMS + email drafts, with per-channel include checkboxes. The owner
// selects (select-all / clear-all + per-row), sees a live "N selected, M SMS, K email" count, and clicks
// "Queue approved for send". That fires each selection through the governed approval path on the server
// (email_send outbox op / held SMS). Post-fire the panel reflects the REAL per-channel outcome (queued /
// held / duplicate / failed) returned by the server — never a bare "sent". Nothing sends without the click.

import { Fragment, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Mail, MessageSquare, Send, AlertTriangle, Clock, MessageSquareReply, Moon, RefreshCw } from "lucide-react";
import type { BulkOutreachCohort, BulkOutreachRow, BulkQueueSummary } from "@/lib/salesos/bulkOutreach";
import { LeadTouchTimeline, LeadTouchLegend } from "@/components/LeadTouchTimeline";

const money = (n: number | null): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));

interface Sel {
  sms: boolean;
  email: boolean;
}

// The three worklist views over the open-quote cohort.
//  • all      — every open quote awaiting movement (the full Goodshuffle Quote Sent stage).
//  • recent   — leads reached out to within the last RECENTLY_CONTACTED_HOURS (r.recentlyContacted); the
//               "who did I just touch, leave them alone" set, defaulted unchecked.
//  • eligible — ready for a touch point NOW: not recently contacted, reachable (phone or email), and the
//               drafter produced a sensible next step. This is the actionable nudge list.
type OutreachFilter = "all" | "recent" | "eligible";

const isEligibleForTouch = (r: BulkOutreachRow): boolean => !r.recentlyContacted && !r.draftFailed && (r.smsAvailable || r.emailAvailable);
const matchesFilter = (r: BulkOutreachRow, f: OutreachFilter): boolean =>
  f === "all" ? true : f === "recent" ? r.recentlyContacted : isEligibleForTouch(r);

type RowOutcome = { email?: { status: string; message: string }; sms?: { status: string; message: string }; skipped?: { channel: string; reason: string }[] };

// The open-quote sub-status chip — surfaces the board nuance Goodshuffle flattens into one "Quote Sent"
// stage. Tokened tones: Recent is calm, Needs follow-up warns (gold), Replied is emphasized (it defaults
// unchecked and needs a tailored response). Never color-alone — the label spells it out.
function SubStatusChip({ subStatus, label }: { subStatus: BulkOutreachRow["subStatus"]; label: string }): React.JSX.Element {
  const tone =
    subStatus === "action_needed"
      ? "bg-foreground text-background font-medium"
      : subStatus === "follow_up"
        ? "border border-border text-attention"
        : "border border-border text-meta";
  return <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] leading-none ${tone}`}>{label}</span>;
}

// One segment of the worklist filter. Active = inverted (foreground) so the current view is unmistakable;
// identity is never color-alone — the active tab also carries the only filled background.
function FilterTab({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1.5 border-r border-border px-3 py-1.5 last:border-r-0 ${active ? "bg-foreground text-background" : "text-tertiary-text hover:bg-[var(--row-hover)]"}`}
    >
      <span>{label}</span>
      <span className={`tabular-nums ${active ? "opacity-80" : "text-meta"}`}>{count}</span>
    </button>
  );
}

const outcomeTone = (status: string): string => {
  if (status === "queued" || status === "sent") return "text-positive";
  if (status === "failed") return "text-critical";
  if (status === "already_sent") return "text-meta";
  return "text-attention"; // approved / held (gate off), etc.
};

export function BulkOutreachPanel({
  cohort,
  showMoney,
  outsideHours = false,
  nextOpenLabel = "business hours",
}: {
  cohort: BulkOutreachCohort;
  showMoney: boolean;
  outsideHours?: boolean;
  nextOpenLabel?: string;
}): React.JSX.Element {
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
  const [filter, setFilter] = useState<OutreachFilter>("all");
  const [resyncing, setResyncing] = useState(false);
  const [resyncNote, setResyncNote] = useState<string | null>(null);

  const subCounts = useMemo(() => {
    let recent = 0;
    let followUp = 0;
    let replied = 0;
    for (const r of cohort.rows) {
      if (r.subStatus === "quote_sent") recent++;
      else if (r.subStatus === "follow_up") followUp++;
      else if (r.subStatus === "action_needed") replied++;
    }
    return { recent, followUp, replied };
  }, [cohort.rows]);

  // Per-view totals for the filter chips (All / Recently reached out to / Eligible for a touch point).
  const filterCounts = useMemo(() => {
    let recent = 0;
    let eligible = 0;
    for (const r of cohort.rows) {
      if (r.recentlyContacted) recent++;
      if (isEligibleForTouch(r)) eligible++;
    }
    return { all: cohort.rows.length, recent, eligible };
  }, [cohort.rows]);

  // The rows the current view shows. Selections are keyed by leadId and persist across view changes, so a
  // filter is a lens, not a reset — but Select all / Clear all and the Queue button operate on THIS set.
  const visibleRows = useMemo(() => cohort.rows.filter((r) => matchesFilter(r, filter)), [cohort.rows, filter]);

  const counts = useMemo(() => {
    let rowsSel = 0;
    let smsN = 0;
    let emailN = 0;
    for (const r of visibleRows) {
      const s = sel[r.leadId];
      if (!s) continue;
      const sms = s.sms && r.smsAvailable;
      const email = s.email && r.emailAvailable;
      if (sms || email) rowsSel++;
      if (sms) smsN++;
      if (email) emailN++;
    }
    return { rowsSel, smsN, emailN };
  }, [sel, visibleRows]);

  const setRow = (id: string, patch: Partial<Sel>): void => setSel((p) => ({ ...p, [id]: { ...p[id], ...patch } }));
  // Columns: Customer, [Quote], Sent, Last touch, Text, Email — the under-row timeline spans them all.
  const colCount = showMoney ? 6 : 5;

  // Select all / Clear all act on the VISIBLE (filtered) rows only, so the filter is how you scope a bulk
  // action — e.g. "Eligible for a touch point" then Select all → Queue.
  const selectAll = (): void => {
    setSel((p) => {
      const next = { ...p };
      for (const r of visibleRows) next[r.leadId] = { sms: r.smsAvailable && !r.draftFailed, email: r.emailAvailable && !r.draftFailed };
      return next;
    });
  };
  const clearAll = (): void => {
    setSel((p) => {
      const next = { ...p };
      for (const r of visibleRows) next[r.leadId] = { sms: false, email: false };
      return next;
    });
  };

  // Re-sync on demand: refresh the two-way text threads for the open-lead cohort from the Quo API, then
  // rebuild the server-rendered cohort (fresh last-touch, timeline, and re-drafted next step). Goodshuffle
  // bookings themselves still refresh on the office Auto-Pull — this syncs the comms the cockpit reads.
  const resync = async (): Promise<void> => {
    setResyncing(true);
    setResyncNote(null);
    setError(null);
    try {
      const res = await fetch("/api/salesos/outreach-resync", { method: "POST" });
      const j = (await res.json()) as { ok?: boolean; leads?: number; inserted?: number; error?: string };
      if (!j.ok) {
        setResyncNote(j.error === "forbidden" ? "Not permitted." : "Re-sync failed.");
        return;
      }
      const leads = j.leads ?? 0;
      const inserted = j.inserted ?? 0;
      setResyncNote(leads === 0 ? "Text sync is not configured — refreshed from the latest pulled data." : `Synced ${leads} lead${leads === 1 ? "" : "s"}, ${inserted} new message${inserted === 1 ? "" : "s"}. Refreshing…`);
      router.refresh();
    } catch {
      setResyncNote("Re-sync failed.");
    } finally {
      setResyncing(false);
    }
  };

  const queue = async (): Promise<void> => {
    setWorking(true);
    setError(null);
    // Only the rows in the current view fire — the counts line, Select all and Queue all agree on this set,
    // so what you see checked is exactly what sends.
    const items = visibleRows
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
        <h1 className="text-[22px] font-medium tracking-tight">Bulk Review &amp; Fire — Open Quotes</h1>
        <p className="text-[12.5px] text-meta">
          Every open quote awaiting movement — the whole Goodshuffle Quote Sent stage: {subCounts.recent} recent, {subCounts.followUp} needing follow-up, {subCounts.replied} where the client replied. Each row carries a refreshed next-step draft and its full conversation timeline. Select rows and channels, then approve. On approval, emails queue through the governed outbox and texts send through the gated Quo sender; nothing goes out without your click, and every send respects the comms gates below.
        </p>
      </header>

      {outsideHours && (
        <p className="mb-4 flex items-start gap-1.5 border border-border bg-panel px-3 py-2 text-[12px] text-meta">
          <Moon className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Outside business hours. Sends you queue now still go out; the bots hold their own recommendations until {nextOpenLabel}.
          </span>
        </p>
      )}

      {/* View controls: scope the cockpit to a worklist, and re-sync the comms it reads on demand. */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex overflow-hidden rounded border border-border bg-panel text-[12.5px]">
          <FilterTab label="All open quotes" count={filterCounts.all} active={filter === "all"} onClick={() => setFilter("all")} />
          <FilterTab label="Recently reached out to" count={filterCounts.recent} active={filter === "recent"} onClick={() => setFilter("recent")} />
          <FilterTab label="Eligible for a touch point" count={filterCounts.eligible} active={filter === "eligible"} onClick={() => setFilter("eligible")} />
        </div>
        <div className="flex items-center gap-2">
          {resyncNote && <span className="text-[11px] text-meta">{resyncNote}</span>}
          <button
            onClick={resync}
            disabled={resyncing}
            title="Refresh two-way texts from Quo for the open-lead cohort and rebuild the drafts, last-touch and timeline. Goodshuffle bookings refresh on the office Auto-Pull."
            className="flex items-center gap-1.5 border border-border bg-[var(--row)] px-3 py-1.5 text-[12.5px] hover:bg-[var(--row-hover)] disabled:opacity-40"
          >
            <RefreshCw className={`size-3.5 ${resyncing ? "animate-spin" : ""}`} /> {resyncing ? "Re-syncing…" : "Re-sync"}
          </button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border border-border bg-panel px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={selectAll} className="border border-border bg-[var(--row)] px-3 py-1.5 text-[12.5px] hover:bg-[var(--row-hover)]">Select all</button>
          <button onClick={clearAll} className="border border-border bg-[var(--row)] px-3 py-1.5 text-[12.5px] hover:bg-[var(--row-hover)]">Clear all</button>
          <span className="ml-1 text-[12.5px] text-tertiary-text">
            {counts.rowsSel} selected{filter !== "all" ? " in this view" : ""}, {counts.smsN} will send SMS, {counts.emailN} will send email.
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
      {!cohort.smsGateOn && (
        <p className="mb-3 flex items-start gap-1.5 border border-border px-3 py-2 text-[12px] text-attention">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> SMS_SEND_ENABLED is off. Approved texts are recorded and held, not sent, until the gate is turned on.
        </p>
      )}
      {error && <p className="mb-3 border border-border px-3 py-2 text-[12px] text-critical">{error}</p>}
      {summary && (
        <p className="mb-3 border border-border px-3 py-2 text-[12px] text-tertiary-text">
          <span className="text-positive">Sent {summary.sentSms} text{summary.sentSms === 1 ? "" : "s"}</span> and queued {summary.queuedEmail} email{summary.queuedEmail === 1 ? "" : "s"} to the outbox
          {summary.heldSms ? `, held ${summary.heldSms} text${summary.heldSms === 1 ? "" : "s"} (SMS gate off)` : ""}
          {summary.heldEmail ? `, held ${summary.heldEmail} email${summary.heldEmail === 1 ? "" : "s"} (email gate off)` : ""}
          {summary.duplicates ? `, ${summary.duplicates} already done today` : ""}
          {summary.failedSms ? `, ${summary.failedSms} text${summary.failedSms === 1 ? "" : "s"} failed` : ""}
          {summary.failed ? `, ${summary.failed} email enqueue${summary.failed === 1 ? "" : "s"} failed` : ""}. Texts are delivered live; queued emails confirm once the office sync reports they landed.
        </p>
      )}

      {visibleRows.length === 0 ? (
        <p className="border border-border px-3 py-16 text-center text-[13.5px] text-muted-foreground">
          {cohort.rows.length === 0
            ? "No open quotes awaiting movement right now."
            : filter === "recent"
              ? "No one has been reached out to recently."
              : filter === "eligible"
                ? "No quotes are eligible for a touch point right now — everyone has been contacted recently or has no sensible next step."
                : "No open quotes awaiting movement right now."}
        </p>
      ) : (
        <>
          <div className="mb-2 flex items-center justify-between gap-3 px-1">
            <LeadTouchLegend />
          </div>
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
              {visibleRows.map((r) => (
                <Fragment key={r.leadId}>
                  <Row r={r} showMoney={showMoney} sel={sel[r.leadId]} setRow={setRow} result={results[r.leadId]} />
                  <tr className="border-b border-[var(--row-rule)] bg-panel">
                    <td colSpan={colCount} className="px-3 pb-3 pt-1">
                      <LeadTouchTimeline touchpoints={r.touchpoints} earlier={r.touchpointsEarlier} />
                    </td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
            </table>
          </div>
        </>
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
    <tr className="align-top">
      <td className="px-3 pb-1 pt-2.5">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">{r.clientName || "Unknown client"}</span>
          <SubStatusChip subStatus={r.subStatus} label={r.subStatusLabel} />
        </div>
        <div className="truncate text-[12px] text-meta" title={r.eventName}>{r.eventName || `Project ${r.leadId}`}</div>
        {r.note && (
          <div className={`mt-1 flex items-start gap-1 text-[11px] ${r.replied ? "text-foreground" : "text-attention"}`}>
            {r.replied ? <MessageSquareReply className="mt-0.5 size-3 shrink-0" /> : r.recentlyContacted ? <Clock className="mt-0.5 size-3 shrink-0" /> : <AlertTriangle className="mt-0.5 size-3 shrink-0" />}
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
