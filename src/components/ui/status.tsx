// StatusBadge — the shared status chip (Nocturne). A tinted, bordered (or solid) pill whose TEXT
// carries the state, so meaning survives without colour. Built on the semantic tone table
// (src/lib/tone.ts), the one vocabulary the whole console shares.
//
// For a dot-plus-label marker, use StatusMark from console-primitives (it predates this file and is
// already used across the blades). This chip fills the gap where a labelled, tinted badge is wanted.
// Server-component safe.

import * as React from "react";
import { cn } from "@/lib/utils";
import { type Tone, TONE_SOFT, TONE_SOLID } from "@/lib/tone";

export function StatusBadge({
  tone,
  variant = "soft",
  icon,
  children,
  uppercase,
  className,
}: {
  tone: Tone;
  /** "soft" (default): tinted chip + hairline border. "solid": denser tinted pill, no border. */
  variant?: "soft" | "solid";
  icon?: React.ReactNode;
  children: React.ReactNode;
  /** Opt-in dense uppercase severity style; off by default (avoid widespread uppercase). */
  uppercase?: boolean;
  className?: string;
}): React.JSX.Element {
  const base =
    variant === "solid"
      ? "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium"
      : "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium";
  return (
    <span
      className={cn(
        base,
        variant === "solid" ? TONE_SOLID[tone] : TONE_SOFT[tone],
        uppercase && "uppercase tracking-wide",
        className
      )}
    >
      {icon}
      {children}
    </span>
  );
}
