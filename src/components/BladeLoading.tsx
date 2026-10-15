// Branded loading state for the console blades. Rendered by the App Router `loading.tsx`
// Suspense boundaries so navigation is instant: the shell (left nav + status bar) stays
// put while the page content shows this on-brand loader instead of a frozen screen.
//
// Brand pieces are reused from the ConsoleNav wordmark (Tent mark in Zoe gold + "ZOE
// OPERATIONS"). Colours come only from Nocturne tokens (--gold, --foreground, text-meta,
// --border) so it reads correctly in both light and dark themes. Motion is applied with
// the `motion-safe:` variant only, so users who set prefers-reduced-motion get a calm,
// static logo + text with no spinning or pulsing.

import { Tent } from "lucide-react";

export function BladeLoading({ message = "Fetching your data" }: { message?: string }) {
  return (
    <div
      className="flex min-h-[60vh] w-full flex-col items-center justify-center gap-6 px-6 text-center"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="relative flex size-16 items-center justify-center">
        {/* Gentle pulsing ring behind the mark — animation only when motion is allowed. */}
        <span
          aria-hidden
          className="absolute inset-0 rounded-full border border-[var(--gold)]/30 motion-safe:animate-ping"
        />
        <span
          aria-hidden
          className="absolute inset-2 rounded-full border border-[var(--gold)]/20"
        />
        <Tent className="relative size-7 text-[var(--gold)] motion-safe:animate-pulse" aria-hidden />
      </div>

      <div className="flex flex-col items-center gap-2">
        <div className="text-[13px] tracking-[0.04em]">
          <span className="font-semibold text-[var(--gold)]">ZOE</span>{" "}
          <span className="text-foreground">OPERATIONS</span>
        </div>
        <p className="text-[12.5px] text-meta">{message}</p>
      </div>
    </div>
  );
}

// A single pulsing placeholder block for content-shaped skeletons. Uses the muted token
// so it tints correctly in both themes; the pulse is motion-safe only.
export function SkeletonBlock({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`rounded bg-[var(--muted)] motion-safe:animate-pulse ${className}`}
    />
  );
}
