import type { Metadata, Viewport } from "next";
import { Crimson_Pro, Inter, Jost } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

// Match the zoeeventsdmv.com brand type system:
//   Crimson Pro (serif) → headings · Inter → body · Jost → buttons/labels.
// All self-hosted by next/font (no runtime request to Google — works offline on
// the truck tablets).
const serif = Crimson_Pro({
  variable: "--font-serif",
  subsets: ["latin"],
  style: ["normal", "italic"],
});

const sans = Inter({
  variable: "--font-body",
  subsets: ["latin"],
});

const label = Jost({
  variable: "--font-jost",
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
  return (
    <html
      lang="en"
      className={`dark ${sans.variable} ${serif.variable} ${label.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster theme="dark" position="top-center" />
      </body>
    </html>
  );
}
