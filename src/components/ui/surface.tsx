// Surface — the flat Nocturne panel used for cards, wells and sections.
// Mirrors the established `.surface border` convention (border does the work, no glow/shadow), so a
// <Surface> renders identically to the hand-rolled panels in Payroll and the other blades.
// Server-component safe.

import * as React from "react";
import { cn } from "@/lib/utils";

const PAD = {
  none: "",
  sm: "p-3",
  md: "p-4",
  lg: "p-5",
} as const;

/**
 * A flat panel. `raised` swaps the base surface for the "lifted" token (popovers/menus/emphasis).
 * Borders are on by default; pass `border={false}` for a bare surface (e.g. a table frame wrapper
 * that supplies its own overflow container).
 */
export function Surface({
  pad = "md",
  raised = false,
  border = true,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  pad?: keyof typeof PAD;
  raised?: boolean;
  border?: boolean;
}): React.JSX.Element {
  return (
    <div
      data-slot="surface"
      className={cn(
        raised ? "bg-lifted" : "surface",
        border && "border border-border",
        PAD[pad],
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}
