"use client";

// App-wide data-health banner: warns when the Goodshuffle Auto-Pull isn't running or GSPRO is signed
// out (so the board isn't silently showing stale/empty data). It renders the server's initial verdict,
// then polls /api/health so it updates live — and, crucially, DISAPPEARS ON ITS OWN once the problem
// is resolved (no navigation needed). Still dismissible per-issue for the session; a different problem
// re-shows, and a resolved-then-new problem clears the old dismissal.

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { AlertTriangle, X } from "lucide-react";

interface Banner {
  level: "error" | "warn";
  title: string;
  detail: string;
}

const POLL_MS = 45_000;

export function PullHealthBanner({ initial, href = "/admin/pull" }: { initial: Banner | null; href?: string }): React.JSX.Element | null {
  const [banner, setBanner] = useState<Banner | null>(initial);
  const [dismissedTitle, setDismissedTitle] = useState<string | null>(null);

  // Read any session dismissal for the current banner once mounted.
  useEffect(() => {
    if (!banner) return;
    try {
      if (sessionStorage.getItem(`zoePullBanner:${banner.title}`) === "1") setDismissedTitle(banner.title);
    } catch {
      /* ignore */
    }
  }, [banner]);

  const poll = useCallback(async () => {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      if (!r.ok) return; // forbidden / offline — leave the current verdict as-is
      const j = (await r.json()) as { banner: Banner | null };
      setBanner(j.banner);
      // Problem cleared → forget any stale dismissal so the next problem shows.
      if (!j.banner) {
        setDismissedTitle(null);
        try { sessionStorage.removeItem(`zoePullBanner:${initial?.title ?? ""}`); } catch { /* ignore */ }
      }
    } catch {
      /* transient — keep showing what we have */
    }
  }, [initial]);

  useEffect(() => {
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  if (!banner) return null; // resolved → gone on its own
  if (dismissedTitle === banner.title) return null; // dismissed this exact issue this session

  const tone =
    banner.level === "error"
      ? "border-red-500/40 bg-red-500/[0.08] text-red-100"
      : "border-amber-500/40 bg-amber-500/[0.08] text-amber-100";

  return (
    <div className={`flex items-start gap-2.5 border-b px-4 py-2.5 text-sm md:px-6 ${tone}`}>
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="font-semibold">{banner.title}.</span> <span className="opacity-90">{banner.detail}</span>{" "}
        <Link href={href} className="whitespace-nowrap underline underline-offset-2 hover:opacity-80">
          Fix it →
        </Link>
      </div>
      <button
        onClick={() => {
          try {
            sessionStorage.setItem(`zoePullBanner:${banner.title}`, "1");
          } catch {
            /* ignore */
          }
          setDismissedTitle(banner.title);
        }}
        aria-label="Dismiss"
        className="shrink-0 rounded p-0.5 opacity-70 hover:bg-white/10 hover:opacity-100"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
