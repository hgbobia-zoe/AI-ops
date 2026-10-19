"use client";

// Sales OS project search — the shared search bar + its state. The query lives in React context on the
// persistent Sales OS layout, so it survives the Board / Worklist / Table toggle (the layout does not
// unmount between those views) AND is mirrored into the URL (?q=) for refresh-survival and shareable
// links. The URL is updated with a short debounce via history.replaceState, so typing filters the
// already-loaded set instantly without a server round-trip. Every view reads the one query from
// useSalesSearch() and filters with the shared matchesQuery, so results are identical everywhere.

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";

interface SalesSearchCtx {
  query: string;
  setQuery: (q: string) => void;
}

const Ctx = createContext<SalesSearchCtx | null>(null);

export function SalesSearchProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const params = useSearchParams();
  // Initialize once from the URL; after mount the context is the source of truth (the URL is synced to it).
  const [query, setQuery] = useState(() => params.get("q") ?? "");

  // Mirror the query into the URL, debounced, without a navigation (no RSC refetch on each keystroke).
  useEffect(() => {
    const id = setTimeout(() => {
      if (typeof window === "undefined") return;
      const url = new URL(window.location.href);
      if (query.trim()) url.searchParams.set("q", query.trim());
      else url.searchParams.delete("q");
      window.history.replaceState(window.history.state, "", url.toString());
    }, 300);
    return () => clearTimeout(id);
  }, [query]);

  return <Ctx.Provider value={{ query, setQuery }}>{children}</Ctx.Provider>;
}

export function useSalesSearch(): SalesSearchCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSalesSearch must be used within a SalesSearchProvider");
  return ctx;
}

/** Append the current query to a view path so the Board/Worklist/Table links keep the URL honest. */
export function withQuery(path: string, query: string): string {
  const q = query.trim();
  return q ? `${path}?q=${encodeURIComponent(q)}` : path;
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
        className="h-8 w-44 rounded-lg border border-white/10 bg-transparent pl-8 pr-7 text-[13px] text-foreground placeholder:text-meta hover:border-white/25 focus:border-white/30 focus:outline-none focus:ring-1 focus:ring-white/20 sm:w-60 [&::-webkit-search-cancel-button]:appearance-none"
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

/** A compact "N of M" result count, shown only when a query is active. */
export function SearchCount({ shown, total }: { shown: number; total: number }): React.JSX.Element | null {
  const { query } = useSalesSearch();
  if (!query.trim()) return null;
  return (
    <span className="text-[12px] tabular-nums text-meta">
      {shown} of {total}
    </span>
  );
}
