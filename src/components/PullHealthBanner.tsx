"use client";

// App-wide data-health banner: warns when the Goodshuffle Auto-Pull isn't running or GSPRO is signed
// out (so the board isn't silently showing stale/empty data). The verdict is computed server-side
// (pullBannerState) and passed in. Dismissible per-issue for the session — a different problem
// (e.g. ok → signed out) re-shows because the key is the title.

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, X } from "lucide-react";

export function PullHealthBanner({ level, title, detail, href = "/admin/pull" }: { level: "error" | "warn"; title: string; detail: string; href?: string }) {
  const [hidden, setHidden] = useState(true); // start hidden to avoid a flash before we read sessionStorage
  const key = `zoePullBanner:${title}`;

  useEffect(() => {
    try {
      setHidden(sessionStorage.getItem(key) === "1");
    } catch {
      setHidden(false);
    }
  }, [key]);

  if (hidden) return null;

  const tone =
    level === "error"
      ? "border-red-500/40 bg-red-500/[0.08] text-red-100"
      : "border-amber-500/40 bg-amber-500/[0.08] text-amber-100";

  return (
    <div className={`flex items-start gap-2.5 border-b px-4 py-2.5 text-sm md:px-6 ${tone}`}>
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="font-semibold">{title}.</span> <span className="opacity-90">{detail}</span>{" "}
        <Link href={href} className="whitespace-nowrap underline underline-offset-2 hover:opacity-80">
          Fix it →
        </Link>
      </div>
      <button
        onClick={() => {
          try {
            sessionStorage.setItem(key, "1");
          } catch {
            /* ignore */
          }
          setHidden(true);
        }}
        aria-label="Dismiss"
        className="shrink-0 rounded p-0.5 opacity-70 hover:bg-white/10 hover:opacity-100"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
