"use client";

// Marketing lead-source attribution — Goodshuffle never tells us how a lead heard about Zoe, so the
// team tags recent bookings with the channel that brought them. The rollup then shows which channels
// actually book and what revenue they carry. Honest and manual; no fabrication.

import { useEffect, useMemo, useState } from "react";
import { Loader2, GitBranch } from "lucide-react";
import { LEAD_CHANNELS, LEAD_CHANNEL_LABEL, type LeadChannel } from "@/lib/marketing/types";

interface Row {
  bookingId: string;
  eventName: string;
  clientName: string;
  eventDate: string | null;
  dateCreated: string | null;
  signed: boolean;
  grandTotal: number | null;
  channel: LeadChannel | null;
  note: string;
}

const money = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : `$${Math.round(n)}`);

export function LeadSourcesBoard(): React.JSX.Element {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [onlyUntagged, setOnlyUntagged] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/marketing/lead-tags").then((r) => r.json()).then((j: { bookings?: Row[] }) => setRows(j.bookings ?? [])).catch(() => setRows([]));
  }, []);

  const rollup = useMemo(() => {
    const m = new Map<LeadChannel, { count: number; revenue: number }>();
    for (const r of rows ?? []) {
      if (!r.channel) continue;
      const cur = m.get(r.channel) ?? { count: 0, revenue: 0 };
      cur.count++;
      if (r.signed && r.grandTotal) cur.revenue += r.grandTotal;
      m.set(r.channel, cur);
    }
    return [...m.entries()].map(([channel, v]) => ({ channel, ...v })).sort((a, b) => b.count - a.count);
  }, [rows]);

  const taggedCount = (rows ?? []).filter((r) => r.channel).length;
  const shown = useMemo(() => (rows ?? []).filter((r) => !onlyUntagged || !r.channel), [rows, onlyUntagged]);
  const maxCount = rollup[0]?.count || 1;

  async function setChannel(bookingId: string, channel: LeadChannel | null, note: string) {
    setSavingId(bookingId);
    setRows((prev) => (prev ?? []).map((r) => (r.bookingId === bookingId ? { ...r, channel, note } : r)));
    try {
      await fetch("/api/marketing/lead-tags", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookingId, channel, note }) });
    } finally {
      setSavingId(null);
    }
  }

  return (
    <main className="max-w-[1000px] p-6">
      <div className="mb-4 text-[12px] text-meta"><span className="text-meta">Marketing</span> / Lead sources</div>
      <header className="mb-4">
        <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight"><GitBranch className="size-5 text-meta" /> Lead sources</h1>
        <p className="mt-1 max-w-prose text-[12.5px] text-meta">Goodshuffle doesn&apos;t record how a lead heard about Zoe, so tag recent bookings with their channel. The rollup below then shows which channels actually book.</p>
      </header>

      {/* Rollup */}
      <div className="mb-5 rounded border border-border p-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[13px] font-medium text-foreground">By channel</h2>
          <span className="text-[11.5px] text-meta">{taggedCount} of {rows?.length ?? 0} tagged</span>
        </div>
        {rollup.length === 0 ? (
          <p className="text-[12.5px] text-meta">Nothing tagged yet. Tag a few bookings below to see the breakdown.</p>
        ) : (
          <ul className="space-y-1.5">
            {rollup.map((c) => (
              <li key={c.channel} className="text-[12.5px]">
                <div className="flex items-center justify-between"><span className="text-foreground">{LEAD_CHANNEL_LABEL[c.channel]}</span><span className="tabular-nums text-meta">{c.count}{c.revenue > 0 ? ` · ${money(c.revenue)}` : ""}</span></div>
                <div className="mt-0.5 h-1 w-full overflow-hidden rounded bg-[var(--bar)]"><div className="h-full bg-positive" style={{ width: `${Math.round((c.count / maxCount) * 100)}%` }} /></div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Recent bookings</h2>
        <label className="flex items-center gap-1.5 text-[12px] text-meta"><input type="checkbox" className="size-3.5 accent-foreground" checked={onlyUntagged} onChange={(e) => setOnlyUntagged(e.target.checked)} /> Untagged only</label>
      </div>

      {rows === null ? (
        <div className="flex items-center gap-2 text-[13px] text-meta"><Loader2 className="size-4 animate-spin" /> Loading…</div>
      ) : shown.length === 0 ? (
        <p className="text-[13px] text-meta">{onlyUntagged ? "Everything recent is tagged. Nice." : "No recent bookings to tag."}</p>
      ) : (
        <div className="overflow-hidden rounded border border-border">
          {shown.map((r) => (
            <div key={r.bookingId} className="flex flex-wrap items-center gap-3 border-t border-[var(--row-rule)] px-3 py-2.5 text-[13px] first:border-t-0">
              <div className="min-w-0 flex-1">
                <div className="truncate text-foreground">{r.eventName || r.clientName || r.bookingId}</div>
                <div className="text-[11.5px] text-meta">{[r.clientName || null, r.dateCreated ? `created ${r.dateCreated}` : null, r.signed ? "signed" : "quote"].filter(Boolean).join(" · ")}</div>
              </div>
              <select
                value={r.channel ?? ""}
                onChange={(e) => setChannel(r.bookingId, (e.target.value || null) as LeadChannel | null, r.note)}
                className="shrink-0 rounded border border-border bg-background px-2 py-1 text-[12.5px] text-tertiary-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">Tag channel…</option>
                {LEAD_CHANNELS.map((c) => <option key={c} value={c}>{LEAD_CHANNEL_LABEL[c]}</option>)}
              </select>
              {savingId === r.bookingId && <Loader2 className="size-3.5 shrink-0 animate-spin text-meta" />}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
