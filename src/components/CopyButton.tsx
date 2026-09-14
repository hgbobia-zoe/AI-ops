"use client";

// Tiny copy-to-clipboard button for draft text/email blocks. Shows a brief "Copied" confirmation.

import { useState } from "react";
import { Copy, Check } from "lucide-react";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }): React.JSX.Element {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        } catch {
          /* clipboard blocked — the text is visible to copy manually */
        }
      }}
      className="flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
    >
      {done ? <Check className="size-3 text-emerald-300" /> : <Copy className="size-3" />} {done ? "Copied" : label}
    </button>
  );
}
