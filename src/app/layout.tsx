import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme/ThemeProvider";

// Single typeface across the console (Nocturne redesign): Inter, self-hosted by
// next/font (no runtime request to Google — works offline on the truck tablets).
// Hierarchy is size + colour + weight (never above 600), not multiple families.
const sans = Inter({
  variable: "--font-body",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Zoe Dispatch",
  description: "AI Operations Platform — Dispatch tablet",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Zoe Dispatch" },
};

// Tablet-first: lock zoom so fast taps don't accidentally pinch-zoom the UI.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#0a0a0a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // No hardcoded theme class here: next-themes' ThemeProvider injects a blocking inline script that sets
  // the `.dark` class on <html> before first paint from the stored/`system`/default-dark preference, so
  // there is no flash of the wrong theme. `suppressHydrationWarning` lets that pre-hydration class edit
  // stand without a React mismatch warning (the script, not React, owns the class).
  return (
    <html
      lang="en"
      className={`${sans.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <ThemeProvider>
          {children}
          {/* Toaster inherits the active theme via next-themes' useTheme (see components/ui/sonner). */}
          <Toaster position="top-center" />
        </ThemeProvider>
      </body>
    </html>
  );
}
