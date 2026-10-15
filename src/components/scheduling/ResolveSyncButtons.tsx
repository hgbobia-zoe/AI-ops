"use client";

// The resolve controls for one needs_review conflict row. "Keep app version" pushes the app shift into
// Connecteam (silent); "Keep Connecteam version" pulls Connecteam's version into the app (or accepts a
// removal). Both call POST /api/scheduling/shift/[id]/resolve-sync and refresh on success. "Keep Connecteam"
// is disabled when Connecteam is unreachable (we won't guess the authoritative version); "Keep app" is
// disabled too (we'd have to write to Connecteam to apply it) — honest when down.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

export function ResolveSyncButtons({
  shiftId,
  canKeepApp,
  canKeepConnecteam,
}: {
  shiftId: string;
  canKeepApp: boolean;
  canKeepConnecteam: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const [working, setWorking] = useState<null | "app" | "connecteam">(null);
  const [error, setError] = useState<string | null>(null);

  async function resolve(winner: "app" | "connecteam"): Promise<void> {
    setWorking(winner);
    setError(null);
    try {
      const res = await fetch(`/api/scheduling/shift/${shiftId}/resolve-sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ winner }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setError(body.message ?? "Couldn't resolve — try again.");
        return;
      }
      toast.success(winner === "app" ? "Kept the app version (pushed to Connecteam)" : "Kept Connecteam's version");
      router.refresh();
    } catch {
      setError("Couldn't resolve — try again.");
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={working !== null || !canKeepApp}
          onClick={() => resolve("app")}
          title={canKeepApp ? "Push the Dispatch version into Connecteam" : "Connecteam is unreachable right now"}
          className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[12px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {working === "app" ? <Loader2 className="size-3 animate-spin" /> : null}
          Keep app version
        </button>
        <button
          type="button"
          disabled={working !== null || !canKeepConnecteam}
          onClick={() => resolve("connecteam")}
          title={canKeepConnecteam ? "Apply Connecteam's version to Dispatch" : "Connecteam is unreachable — can't apply its version right now"}
          className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[12px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {working === "connecteam" ? <Loader2 className="size-3 animate-spin" /> : null}
          Keep Connecteam version
        </button>
      </div>
      {error && <p className="text-[12px] text-critical">{error}</p>}
    </div>
  );
}
