"use client";

// Inline loss-reason tagger for a lost quote. Saves on change to /api/salesos/lost-reason and reflects
// the saved state optimistically. Deliberately tiny — one <select>, no modal.

import { useState } from "react";

export function LossReasonSelect({ id, reasons, initial }: { id: string; reasons: string[]; initial: string | null }): React.JSX.Element {
  const [value, setValue] = useState<string>(initial ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  const onChange = async (next: string): Promise<void> => {
    const prev = value;
    setValue(next);
    setSaving(true);
    setError(false);
    try {
      const res = await fetch("/api/salesos/lost-reason", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, reason: next || null }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setValue(prev); // revert on failure — never show a save that didn't happen
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-1.5">
      <select
        value={value}
        onChange={(e) => void onChange(e.target.value)}
        disabled={saving}
        aria-label="Loss reason"
        className={`max-w-[11rem] truncate border bg-transparent px-1.5 py-0.5 text-[11px] outline-none ${
          value ? "border-white/20 text-foreground" : "border-white/10 text-muted-foreground"
        } ${error ? "border-rose-500/50" : ""}`}
      >
        <option value="">Tag reason…</option>
        {reasons.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      {error && <span className="text-[10px] text-rose-300">retry</span>}
    </span>
  );
}
