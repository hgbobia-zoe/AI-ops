"use client";

// Stage 7b — team-level saved views for /finance. A small Nocturne dropdown (self-contained, so it avoids
// the Base UI Menu GroupLabel-in-a-Group gotcha entirely): apply a saved view (navigates to its stored URL
// state), delete one, or save the CURRENT dashboard state under a name. Owner/admin only — the whole blade
// and /api/finance are gated there. Persistence is server-side (finance_saved_views), idempotent by name.

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Trash2, Check } from "lucide-react";

export interface SavedViewLite {
  id: string;
  name: string;
  state: Record<string, string>;
}

/** Build the /finance URL for a saved view's stored state (only known keys, in a stable order). */
function urlForState(state: Record<string, string>): string {
  const p = new URLSearchParams();
  for (const k of ["view", "period", "start", "end", "project", "lineage"]) {
    if (state[k]) p.set(k, state[k]);
  }
  const q = p.toString();
  return q ? `/finance?${q}` : "/finance";
}

export function FinanceSavedViews({
  views,
  currentState,
}: {
  views: SavedViewLite[];
  currentState: Record<string, string>;
}): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent): void => {
      if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(false);
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const apply = (v: SavedViewLite): void => {
    setOpen(false);
    router.push(urlForState(v.state));
  };

  const save = async (): Promise<void> => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/finance/saved-views", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: n, state: currentState }),
      });
      if (!res.ok) {
        setError(res.status === 403 ? "Not permitted" : "Could not save");
        return;
      }
      setName("");
      router.refresh();
    } catch {
      setError("Could not save");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (v: SavedViewLite): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/finance/saved-views?id=${encodeURIComponent(v.id)}`, { method: "DELETE" });
      if (!res.ok) {
        setError("Could not delete");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not delete");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded border border-border bg-panel px-2.5 py-1 text-[12.5px] text-foreground transition-colors hover:border-foreground/40"
      >
        Saved views
        {views.length > 0 && <span className="text-meta">({views.length})</span>}
        <ChevronDown className="size-3.5 text-meta" />
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-1 w-72 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-md ring-1 ring-foreground/10">
          <div className="px-1.5 py-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Saved views</div>
          {views.length === 0 ? (
            <div className="px-1.5 py-2 text-[12.5px] text-meta">None saved yet.</div>
          ) : (
            <ul className="max-h-60 overflow-y-auto">
              {views.map((v) => (
                <li key={v.id} className="group flex items-center justify-between gap-1 rounded-md px-1.5 py-1 hover:bg-accent">
                  <button type="button" onClick={() => apply(v)} className="flex-1 truncate text-left text-[13px] text-foreground">
                    {v.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(v)}
                    disabled={busy}
                    aria-label={`Delete ${v.name}`}
                    className="shrink-0 rounded p-1 text-meta opacity-60 transition hover:text-critical hover:opacity-100 disabled:opacity-30"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-1 border-t border-border pt-1.5">
            <div className="flex items-center gap-1 px-0.5">
              <input
                type="text"
                value={name}
                maxLength={60}
                placeholder="Save current view as…"
                onChange={(ev) => setName(ev.target.value)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter") void save();
                }}
                className="min-w-0 flex-1 rounded border border-border bg-panel px-2 py-1 text-[12.5px] text-foreground outline-none focus:border-foreground/40"
              />
              <button
                type="button"
                onClick={() => void save()}
                disabled={!name.trim() || busy}
                aria-label="Save current view"
                className="flex shrink-0 items-center gap-1 rounded bg-foreground px-2 py-1 text-[12.5px] font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Check className="size-3.5" />
                Save
              </button>
            </div>
            {error && <p className="px-1.5 pt-1 text-[11.5px] text-critical">{error}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
