"use client";

// App-wide data-health banner: warns when the Goodshuffle Auto-Pull isn't running or GSPRO is signed
// out (so the board isn't silently showing stale/empty data). It renders the server's initial verdict,
// then polls /api/health so it updates live — and DISAPPEARS ON ITS OWN once the problem is resolved
// (a fresh successful pull), no navigation needed. It is intentionally NOT dismissible: a stale-data
// warning must not be clickable-away while the issue is still live — it goes only when the data is
// actually current again.

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";

interface Banner {
  level: "error" | "warn";
  title: string;
  detail: string;
}

const POLL_MS = 45_000;

export function PullHealthBanner({ initial, href = "/admin/pull" }: { initial: Banner | null; href?: string }): React.JSX.Element | null {
  const [banner, setBanner] = useState<Banner | null>(initial);

  const poll = useCallback(async () => {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      if (!r.ok) return; // forbidden / offline — leave the current verdict as-is
      const j = (await r.json()) as { banner: Banner | null };
      setBanner(j.banner); // null once resolved → banner clears itself
    } catch {
      /* transient — keep showing what we have */
    }
  }, []);

  useEffect(() => {
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  if (!banner) return null; // resolved → gone on its own

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
    </div>
  );
}
