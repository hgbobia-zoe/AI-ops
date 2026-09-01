"use client";

// Office action on the dispatch board: mark an exception resolved once it's handled.
// Clears it from the open list.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";

export function ResolveExceptionButton({ exceptionId }: { exceptionId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function resolve() {
    setBusy(true);
    try {
      await fetch("/api/exception/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exceptionId }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={resolve}
      disabled={busy}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-white/15 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
    >
      <Check className="size-3.5" /> {busy ? "…" : "Resolve"}
    </button>
  );
}
