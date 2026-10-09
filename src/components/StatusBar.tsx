"use client";

// Console status bar (Nocturne) — a 44px strip under the header: live date/time, then each integration as
// a CHIP (brand logo / category icon · name · status dot · freshness · Fix →), live counts on the
// right. The colored dot carries state (ok/warn/down/idle) — no state word is shown. Integration
// state is computed server-side and passed in; the clock ticks client-side.

import { useEffect, useState } from "react";
import Link from "next/link";
import { Phone, MapPin, Navigation, Plug, ArrowRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface StatusIntegration {
  name: string;
  tone: "ok" | "warn" | "down" | "idle";
  note?: string; // freshness / consequence, e.g. "2h ago" or "unavailable since 1:48 PM · 2 queued"
  fixHref?: string; // where to go to fix it (shows a Fix → link)
}
export interface StatusCount {
  label: string;
  value: string | number;
  tone?: "ok" | "warn" | "down";
}

// State word — kept for the dot's accessible label/tooltip only (no longer shown as a tag).
const STATE_LABEL: Record<string, string> = { ok: "Live", warn: "Stale", down: "Disconnected", idle: "Idle" };
// Status dot fill by tone (the dot now carries the state the old tag box used to spell out).
const DOT_BG: Record<string, string> = { ok: "bg-positive", warn: "bg-attention", down: "bg-critical", idle: "bg-meta" };
const CHIP_BORDER: Record<string, string> = { ok: "border-border", warn: "border-attention/35", down: "border-critical/40", idle: "border-border" };

// Brand logos for the true single-app integrations (bundled under /public/logos, drawn in their own
// colors — the status dot carries tone, so we never tint these). Each sits on a tiny light pill so it
// reads on the dark chip background regardless of the logo's own background.
const LOGO: Record<string, string> = {
  Goodshuffle: "/logos/goodshuffle.png",
  Connecteam: "/logos/connecteam.png",
  Instawork: "/logos/instawork.png",
};

// Category chips are provider-abstracted (not a single brand), so they keep a clean, neutral lucide icon.
const ICON: Record<string, LucideIcon> = {
  Quo: Phone,
  GPS: MapPin,
  "GPS / Ignition": Navigation,
  Ignition: Navigation,
};

export function StatusBar({ integrations, counts }: { integrations: StatusIntegration[]; counts?: StatusCount[] }): React.JSX.Element {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mounted-clock pattern (avoids SSR hydration mismatch); matches kiosk/route pages
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-background px-4 text-[12px]">
      <span className="shrink-0 whitespace-nowrap text-foreground tabular-nums">
        {now ? now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : ""}
        {now ? <span className="ml-2 text-meta">{now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</span> : ""}
      </span>

      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
        {integrations.map((i) => {
          const logo = LOGO[i.name];
          const Icon = ICON[i.name] ?? Plug;
          return (
            <span key={i.name} className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border bg-[#151722] px-2.5 ${CHIP_BORDER[i.tone]}`}>
              {logo ? (
                <span className="inline-flex size-[18px] shrink-0 items-center justify-center overflow-hidden rounded bg-white/90 p-0.5">
                  {/* eslint-disable-next-line @next/next/no-img-element -- bundled local asset; next/image needs no optimization here */}
                  <img src={logo} alt={i.name} className="size-full object-contain" />
                </span>
              ) : (
                <Icon className="size-3.5 text-meta" />
              )}
              <span className="text-foreground">{i.name}</span>
              <span className={`size-2 shrink-0 rounded-full ${DOT_BG[i.tone]}`} title={STATE_LABEL[i.tone]} aria-label={STATE_LABEL[i.tone]} role="img" />
              {i.note && <span className="max-w-[140px] truncate text-meta">{i.note}</span>}
              {i.fixHref && (i.tone === "down" || i.tone === "warn") && (
                <Link href={i.fixHref} className="inline-flex items-center gap-0.5 text-[#9fb6e6] hover:underline">Fix <ArrowRight className="size-3" /></Link>
              )}
            </span>
          );
        })}
      </div>

      {counts && counts.length > 0 && (
        <div className="flex shrink-0 items-center gap-4">
          {counts.map((c) => (
            <span key={c.label} className="flex items-center gap-1.5">
              <span className="text-[10.5px] uppercase tracking-[0.1em] text-meta">{c.label}</span>
              <span className={`tabular-nums ${c.tone === "warn" ? "text-attention" : c.tone === "down" ? "text-critical" : "text-foreground"}`}>{c.value}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
