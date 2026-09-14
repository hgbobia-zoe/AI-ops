"use client";

// Slide-over shell for the intercepted lead route (Jira-style quick view). Renders the FULL lead board
// in a right-hand panel over whatever view you were on; closing returns you there. Closes on backdrop,
// the ✕, or Esc.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";

export function LeadModal({ children }: { children: React.ReactNode }): React.JSX.Element {
  const router = useRouter();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") router.back(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [router]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={() => router.back()} aria-hidden />
      <div className="surface relative flex h-full w-full max-w-3xl flex-col border-l border-white/10 shadow-2xl">
        <div className="flex items-center justify-end border-b border-white/10 p-2">
          <button onClick={() => router.back()} aria-label="Close" className="rounded p-1 text-muted-foreground hover:bg-white/10 hover:text-foreground"><X className="size-5" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
