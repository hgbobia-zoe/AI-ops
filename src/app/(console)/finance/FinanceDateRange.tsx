"use client";

// Stage 7b — custom date-range control for /finance. A pair of native date inputs + Apply, reflecting the
// chosen range into the URL (?start=&end=) so it's shareable and back-button-safe. Applying a range drops
// any preset ?period=; Clear removes the range (→ the default preset). The server validates the range
// deterministically (customRange in periods.ts) and falls back to the default preset on anything invalid,
// so this control only needs a light "both set + start ≤ end" check to enable Apply. The preset dropdown
// lives beside it as the existing period tabs; this is the custom half of "presets + custom".

import { useRouter } from "next/navigation";
import { useState } from "react";

/** The non-date params to carry across an apply/clear (so the view + any project filter survive). */
export type CarryParams = Record<string, string>;

export function FinanceDateRange({
  start,
  end,
  active,
  carry,
}: {
  start: string | null;
  end: string | null;
  active: boolean;
  carry: CarryParams;
}): React.JSX.Element {
  const router = useRouter();
  const [s, setS] = useState(start ?? "");
  const [e, setE] = useState(end ?? "");

  const canApply = Boolean(s) && Boolean(e) && s <= e;

  const apply = (): void => {
    if (!canApply) return;
    const p = new URLSearchParams(carry);
    p.delete("period");
    p.set("start", s);
    p.set("end", e);
    router.push(`/finance?${p.toString()}`);
  };

  const clear = (): void => {
    const p = new URLSearchParams(carry);
    p.delete("start");
    p.delete("end");
    const q = p.toString();
    router.push(q ? `/finance?${q}` : "/finance");
  };

  const inputCls =
    "rounded border border-border bg-panel px-2 py-1 text-[12.5px] tabular-nums text-foreground outline-none focus:border-foreground/40";

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-[0.08em] text-meta">Custom</span>
      <input
        type="date"
        aria-label="Range start"
        value={s}
        max={e || undefined}
        onChange={(ev) => setS(ev.target.value)}
        className={inputCls}
      />
      <span className="text-meta">→</span>
      <input
        type="date"
        aria-label="Range end"
        value={e}
        min={s || undefined}
        onChange={(ev) => setE(ev.target.value)}
        className={inputCls}
      />
      <button
        type="button"
        onClick={apply}
        disabled={!canApply}
        className="rounded bg-foreground px-2.5 py-1 text-[12.5px] font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Apply
      </button>
      {active && (
        <button
          type="button"
          onClick={clear}
          className="rounded px-2 py-1 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground"
        >
          Clear
        </button>
      )}
    </div>
  );
}
