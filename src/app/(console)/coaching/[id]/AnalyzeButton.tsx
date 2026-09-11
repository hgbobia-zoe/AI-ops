"use client";

// Submit button for the coaching-analysis server action, with a pending state so the rep sees the
// ~10-30s LLM call is working rather than a dead button.

import { useFormStatus } from "react-dom";
import { Sparkles, Loader2 } from "lucide-react";

export function AnalyzeButton({ label }: { label: string }): React.JSX.Element {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-hero flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium disabled:opacity-60"
    >
      {pending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
      {pending ? "Analyzing…" : label}
    </button>
  );
}
