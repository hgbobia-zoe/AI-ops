"use client";

// App theme provider — thin wrapper over next-themes that pins the platform's theme config in one
// place. It injects the blocking inline script that sets the `.dark` class on <html> before first
// paint (so there is no flash of the wrong theme), persists the choice to localStorage under
// "zoe-theme", and resolves "system" against the OS preference.
//
//   attribute="class"      → toggles the `.dark` class the Nocturne tokens key off (globals.css).
//   defaultTheme="dark"    → the app ships dark-first; no stored preference resolves to dark.
//   enableSystem           → "System" follows prefers-color-scheme.
//   disableTransitionOnChange → no colour-transition smear when flipping themes.

import { ThemeProvider as NextThemeProvider } from "next-themes";
import { THEME_STORAGE_KEY, DEFAULT_THEME } from "@/lib/theme";

export function ThemeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <NextThemeProvider
      attribute="class"
      defaultTheme={DEFAULT_THEME}
      enableSystem
      storageKey={THEME_STORAGE_KEY}
      disableTransitionOnChange
    >
      {children}
    </NextThemeProvider>
  );
}
