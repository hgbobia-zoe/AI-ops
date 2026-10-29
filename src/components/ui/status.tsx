// StatusBadge — the shared status renderer (Nocturne, Spectrum-style).
//
// A status is a small COLOURED INDICATOR (a distinct-shape icon) + a crisp label on the neutral
// surface inherited from the row/panel. Colour lives on the indicator; the label is the high-contrast
// label colour (white on dark, ink on light) and is never tinted to match. Meaning is carried by the
// icon SHAPE + the text, so it survives colour-blindness and greyscale. No pill, no outline, no pastel
// for the routine treatment — `filled` is the reserved exceptional case only.
//
// Icons come from the existing library (lucide), ~16px, with an 8px gap before the label. The syncing
// spinner animates ONLY when genuinely active and only under motion-safe.
// Server-component safe.

import * as React from "react";
import {
  CheckCircle2,
  CircleX,
  AlertTriangle,
  Loader2,
  CircleDashed,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { type Tone, STATUS_INDICATOR, STATUS_LABEL, STATUS_FILL } from "@/lib/tone";

/** Default distinct-shape icon per tone. check / X-in-circle / triangle / spinner / dashed-circle. */
export const STATUS_ICON: Record<Tone, LucideIcon> = {
  positive: CheckCircle2,
  critical: CircleX,
  attention: AlertTriangle,
  info: Loader2,
  neutral: CircleDashed,
};

export function StatusBadge({
  tone,
  children,
  icon,
  filled = false,
  animated = false,
  size = "md",
  className,
}: {
  tone: Tone;
  children: React.ReactNode;
  /** Override the default per-tone icon. */
  icon?: LucideIcon;
  /** Reserved EXCEPTIONAL case: a solid approved-colour fill. Not the routine table treatment. */
  filled?: boolean;
  /** Spin the indicator — honoured only for the syncing (info) tone and only under motion-safe. */
  animated?: boolean;
  size?: "sm" | "md";
  className?: string;
}): React.JSX.Element {
  const Icon = icon ?? STATUS_ICON[tone];
  const iconSize = size === "sm" ? "size-3.5" : "size-4";
  const labelSize = size === "sm" ? "text-[11.5px]" : "text-[12.5px]";
  const spin = animated && tone === "info";

  if (filled) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-medium",
          labelSize,
          STATUS_FILL[tone],
          className
        )}
      >
        <Icon className={cn(iconSize, spin && "motion-safe:animate-spin")} aria-hidden />
        {children}
      </span>
    );
  }

  return (
    <span className={cn("inline-flex items-center gap-2 font-medium", labelSize, className)}>
      <Icon
        className={cn(iconSize, "shrink-0", STATUS_INDICATOR[tone], spin && "motion-safe:animate-spin")}
        aria-hidden
      />
      <span className={STATUS_LABEL}>{children}</span>
    </span>
  );
}
