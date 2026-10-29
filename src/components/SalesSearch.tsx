"use client";

// Sales OS project search — the shared search bar + its state. The query lives in React context on the
// persistent Sales OS layout, so it survives the Board / Worklist / Table toggle (the layout does not
// unmount between those views) AND is mirrored into the URL (?q=) for refresh-survival and shareable
// links. The URL is updated with a short debounce via history.replaceState, so typing filters the
// already-loaded set instantly without a server round-trip. Every view reads the one query from
// useSalesSearch() and filters with the shared matchesQuery, so results are identical everywhere.

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Search, X, ClipboardList } from "lucide-react";
import { BOARD_COLUMNS, STATE_FILTERS, type BoardStatus } from "@/lib/salesos/boardTypes";

/** The active lead-state filter: a single board status, or null for "all" (the default). */
export type StateFilter = BoardStatus | null;

const VALID_STATES = new Set<string>(BOARD_COLUMNS.map((c) => c.key));
const coerceState = (raw: string | null): StateFilter => (raw && VALID_STATES.has(raw) ? (raw as BoardStatus) : null);

interface SalesSearchCtx {
  query: string;
  setQuery: (q: string) => void;
  stateFilter: StateFilter;
  setStateFilter: (s: StateFilter) => void;
  /** User-controlled scope: show only incomplete records (missing name/date). Never auto-applied. */
  incompleteOnly: boolean;
  setIncompleteOnly: (v: boolean) => void;
}

const Ctx = createContext<SalesSearchCtx | null>(null);

export function SalesSearchProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const params = useSearchParams();
  // Initialize once from the URL; after mount the context is the source of truth (the URL is synced to it).
  const [query, setQuery] = useState(() => params.get("q") ?? "");
  const [stateFilter, setStateFilter] = useState<StateFilter>(() => coerceState(params.get("state")));
  const [incompleteOnly, setIncompleteOnly] = useState<boolean>(() => params.get("incomplete") === "1");

  // Mirror query + state + incomplete scope into the URL, debounced, without a navigation (no RSC refetch
  // per keystroke). The whole Sales OS layout stays mounted across the Board/Worklist/Table toggle, so this
  // context survives the switch; the URL mirror is purely for refresh-survival and shareable links.
  useEffect(() => {
    const id = setTimeout(() => {
      if (typeof window === "undefined") return;
      const url = new URL(window.location.href);
      if (query.trim()) url.searchParams.set("q", query.trim());
      else url.searchParams.delete("q");
      if (stateFilter) url.searchParams.set("state", stateFilter);
      else url.searchParams.delete("state");
      if (incompleteOnly) url.searchParams.set("incomplete", "1");
      else url.searchParams.delete("incomplete");
      window.history.replaceState(window.history.state, "", url.toString());
    }, 300);
    return () => clearTimeout(id);
  }, [query, stateFilter, incompleteOnly]);

  return <Ctx.Provider value={{ query, setQuery, stateFilter, setStateFilter, incompleteOnly, setIncompleteOnly }}>{children}</Ctx.Provider>;
}

export function useSalesSearch(): SalesSearchCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSalesSearch must be used within a SalesSearchProvider");
  return ctx;
}

/** Append the current query + state filter to a view path so the Board/Worklist/Table links keep the
 *  URL honest across a view switch (the in-memory context already survives it). */
export function withQuery(path: string, query: string, stateFilter?: StateFilter, incompleteOnly?: boolean): string {
  const parts: string[] = [];
  const q = query.trim();
  if (q) parts.push(`q=${encodeURIComponent(q)}`);
  if (stateFilter) parts.push(`state=${encodeURIComponent(stateFilter)}`);
  if (incompleteOnly) parts.push("incomplete=1");
  return parts.length ? `${path}?${parts.join("&")}` : path;
}

/** The header search input: instant typing, a clear (×) button, Escape to clear. */
export function SalesSearchBar(): React.JSX.Element {
  const { query, setQuery } = useSalesSearch();
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="relative inline-flex items-center">
      <Search className="pointer-events-none absolute left-2.5 size-3.5 text-meta" aria-hidden />
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && query) {
            e.preventDefault();
            setQuery("");
          }
        }}
        placeholder="Search projects…"
        aria-label="Search projects by client, name, address, value or stage"
        className="h-8 w-44 rounded-lg border border-input bg-transparent pl-8 pr-7 text-[13px] text-foreground placeholder:text-meta hover:border-foreground/30 focus:border-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring sm:w-60 [&::-webkit-search-cancel-button]:appearance-none"
      />
      {query && (
        <button
          type="button"
          onClick={() => {
            setQuery("");
            inputRef.current?.focus();
          }}
          aria-label="Clear search"
          className="absolute right-1.5 rounded p-0.5 text-meta transition-colors hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/** A compact "N of M" result count, shown when a search query OR a state filter is active. */
export function SearchCount({ shown, total }: { shown: number; total: number }): React.JSX.Element | null {
  const { query, stateFilter } = useSalesSearch();
  if (!query.trim() && !stateFilter) return null;
  return (
    <span className="text-[12px] tabular-nums text-meta">
      {shown} of {total}
    </span>
  );
}

/** The user-controlled "Needs details" scope toggle: narrows every view to the incomplete (unnamed/
 *  undated) records so a rep can triage them on purpose. Nothing is ever auto-hidden — this is the only
 *  thing that removes those records from view, and it is off by default. `count`, when known for the
 *  active view, is shown so the rep sees how many there are before narrowing. */
export function IncompleteToggle({ count }: { count?: number }): React.JSX.Element {
  const { incompleteOnly, setIncompleteOnly } = useSalesSearch();
  return (
    <button
      type="button"
      aria-pressed={incompleteOnly}
      onClick={() => setIncompleteOnly(!incompleteOnly)}
      title="Show only projects missing an event name or date"
      className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] font-medium transition-colors ${
        incompleteOnly ? "border-foreground/40 bg-foreground/10 text-foreground" : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"
      }`}
    >
      <ClipboardList className="size-3.5" aria-hidden /> Needs details
      {typeof count === "number" && count > 0 && <span className="tabular-nums text-attention">{count}</span>}
    </button>
  );
}

/** Goodshuffle-style lead-state filter: a row of pills (All + the four states) in the shared header,
 *  next to the search. Single-select; clicking the active pill (or All) clears it. Writes the one
 *  shared stateFilter, so every view narrows by the SAME classification and composes it with search. */
export function StateFilterBar(): React.JSX.Element {
  const { stateFilter, setStateFilter } = useSalesSearch();
  const pill = (on: boolean): string =>
    `h-8 rounded-lg border px-2.5 text-[12.5px] font-medium transition-colors ${
      on ? "border-foreground/40 bg-foreground/10 text-foreground" : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"
    }`;
  return (
    <div role="group" aria-label="Filter by lead state" className="inline-flex items-center gap-1.5">
      <button type="button" aria-pressed={stateFilter === null} onClick={() => setStateFilter(null)} className={pill(stateFilter === null)}>
        All
      </button>
      {STATE_FILTERS.map((s) => {
        const on = stateFilter === s.key;
        return (
          <button key={s.key} type="button" aria-pressed={on} onClick={() => setStateFilter(on ? null : s.key)} className={pill(on)}>
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
