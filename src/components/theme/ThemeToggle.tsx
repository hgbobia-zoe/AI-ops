"use client";

// The shell's light/dark/system toggle. State, persistence (localStorage "zoe-theme") and the
// no-flash-before-hydration init script are all handled by next-themes (wired in the root layout);
// this is just the control. It cycles Dark → Light → System and shows the current choice's icon.
//
// next-themes returns an undefined theme during SSR/first paint (it can't know the stored value on the
// server), so we render a neutral, inert placeholder until mounted — avoiding a hydration mismatch and
// a wrong-icon flash. The pure cycle/label logic lives in @/lib/theme so it is unit-testable.

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun, Monitor } from "lucide-react";
import { nextTheme, parseTheme, THEME_META, type Theme } from "@/lib/theme";

const ICON = { moon: Moon, sun: Sun, monitor: Monitor } as const;

export function ThemeToggle({ className }: { className?: string }): React.JSX.Element {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mounted guard for next-themes (SSR has no stored value)
    setMounted(true);
  }, []);

  const base =
    "inline-flex size-8 shrink-0 items-center justify-center rounded border border-border text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0";

  if (!mounted) {
    // Inert placeholder matched to the final size so the header layout doesn't shift on hydration.
    return <span className={`${base} ${className ?? ""}`} aria-hidden />;
  }

  const current: Theme = parseTheme(theme);
  const upcoming = nextTheme(current);
  const meta = THEME_META[current];
  const Icon = ICON[meta.icon];

  return (
    <button
      type="button"
      onClick={() => setTheme(upcoming)}
      aria-label={`Theme: ${meta.label}. Switch to ${THEME_META[upcoming].label}.`}
      title={`Theme: ${meta.label} (switch to ${THEME_META[upcoming].label})`}
      className={`${base} ${className ?? ""}`}
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}
