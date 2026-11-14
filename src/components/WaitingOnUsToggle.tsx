"use client";

// "Waiting on us" on a lead (owner, 2026-11-14). A rep marks it when the customer is waiting on an answer
// from us; a marked lead is never auto closed as lost at 3 days to the event and the morning text holds.
// Shows who marked it. The system also detects it from the conversation (shown read only).

import { useState } from "react";
import { Hourglass } from "lucide-react";

export interface WaitingMarkView {
  markedBy: string;
  markedAt: string;
  note: string | null;
}

const day = (iso: string): string => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });

export function WaitingOnUsToggle({ id, initial, detected }: { id: string; initial: WaitingMarkView | null; detected: string | null }): React.JSX.Element {
  const [mark, setMark] = useState<WaitingMarkView | null>(initial);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (on: boolean): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/salesos/waiting-on-us", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, on, note: on ? note : null }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; mark?: WaitingMarkView | null; error?: string };
      if (!res.ok || !j.ok) throw new Error(j.error || String(res.status));
      setMark(j.mark ?? null);
      setOpen(false);
      setNote("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 text-xs">
      {mark ? (
        <div className="flex flex-wrap items-center gap-2 border border-amber-400/30 bg-amber-400/[0.06] px-2.5 py-1.5">
          <Hourglass className="size-3.5 text-amber-200" />
          <span>
            Waiting on us, marked by {mark.markedBy} on {day(mark.markedAt)}
            {mark.note ? ` (${mark.note})` : ""}. It will not be marked lost on its own.
          </span>
          <button type="button" disabled={saving} onClick={() => void save(false)} className="ml-auto border border-white/15 px-2 py-0.5 hover:bg-white/5">
            {saving ? "Saving" : "Clear"}
          </button>
        </div>
      ) : open ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={300}
            placeholder="What do they need from us? (optional)"
            aria-label="What the customer is waiting for"
            className="min-w-[14rem] flex-1 border border-white/15 bg-transparent px-2 py-1 outline-none"
          />
          <button type="button" disabled={saving} onClick={() => void save(true)} className="border border-amber-400/40 px-2 py-1 text-amber-100 hover:bg-amber-400/10">
            {saving ? "Saving" : "Mark waiting on us"}
          </button>
          <button type="button" disabled={saving} onClick={() => setOpen(false)} className="px-2 py-1 text-muted-foreground hover:text-foreground">
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-1.5 border border-white/15 px-2.5 py-1 hover:bg-white/5">
          <Hourglass className="size-3.5" /> Mark waiting on us
        </button>
      )}
      {!mark && detected && <p className="mt-1.5 text-amber-200">{detected} It will not be marked lost on its own.</p>}
      {error && <p className="mt-1 text-rose-300">{error}</p>}
    </div>
  );
}
