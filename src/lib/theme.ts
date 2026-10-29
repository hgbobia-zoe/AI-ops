// Theme vocabulary for the app shell. The actual light/dark switching, persistence, and
// no-flash-before-hydration init script are handled by `next-themes` (wired in the root layout via its
// <ThemeProvider attribute="class" defaultTheme="dark" enableSystem storageKey="zoe-theme">). The CSS
// system is class-based: `.dark` on <html> selects the dark tokens, its absence falls through to the
// light `:root` set (see src/app/globals.css + docs/DESIGN_SYSTEM.md §6). The app DEFAULTS to dark.
//
// This module holds only the PURE, framework-free pieces the toggle needs — kept here so they are unit
// testable in the node test env (the component that renders them is not). No React, no DOM, no storage.

export type Theme = "light" | "dark" | "system";

/** The user-selectable themes, in the order the toggle cycles through them (dark is the default/home). */
export const THEME_SEQUENCE: readonly Theme[] = ["dark", "light", "system"] as const;

/** localStorage key — MUST match the `storageKey` passed to next-themes' ThemeProvider. */
export const THEME_STORAGE_KEY = "zoe-theme";

/** The default theme when the viewer has expressed no preference. The app ships dark-first. */
export const DEFAULT_THEME: Theme = "dark";

export function isTheme(x: unknown): x is Theme {
  return x === "light" || x === "dark" || x === "system";
}

/** Normalise an arbitrary stored value to a known theme, defaulting to dark. Pure. */
export function parseTheme(raw: unknown): Theme {
  return isTheme(raw) ? raw : DEFAULT_THEME;
}

/** The next theme in the cycle (dark → light → system → dark). Unknown input restarts at the default. */
export function nextTheme(current: Theme | undefined | null): Theme {
  const i = THEME_SEQUENCE.indexOf(current as Theme);
  if (i === -1) return DEFAULT_THEME;
  return THEME_SEQUENCE[(i + 1) % THEME_SEQUENCE.length];
}

/** The concrete appearance a theme choice resolves to, given the OS preference. Pure. */
export function resolveTheme(theme: Theme | undefined | null, systemPrefersDark: boolean): "light" | "dark" {
  const t = parseTheme(theme);
  if (t === "system") return systemPrefersDark ? "dark" : "light";
  return t;
}

/** Presentation metadata for the toggle control (label + lucide icon name). The component maps the name
 *  to the actual icon; keeping it a string keeps this module React-free and testable. */
export const THEME_META: Record<Theme, { label: string; icon: "moon" | "sun" | "monitor" }> = {
  dark: { label: "Dark", icon: "moon" },
  light: { label: "Light", icon: "sun" },
  system: { label: "System", icon: "monitor" },
};
