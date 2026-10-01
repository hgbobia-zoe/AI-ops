"use client";

// Instawork session cookie — write-only provider field in /admin. The cookie is never shown again; GET
// reports only whether it's set, POST stores/clears it (owner/admin). On save it probes once so you see
// whether the cookie actually reaches Instawork. Paste the full Cookie header from a logged-in Instawork
// business tab (DevTools → Network → any app.instawork.com request → Request Headers → cookie).

import { useEffect, useState } from "react";
import { Loader2, Check, Trash2 } from "lucide-react";

interface Probe {
  ok: boolean;
  status: string;
  shifts: number;
  error: string | null;
}

export function InstaworkCredentialSettings(): React.JSX.Element {
  const [set, setSet] = useState<boolean | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/instawork/provider")
      .then((r) => r.json())
      .then((d: { set: boolean }) => setSet(d.set))
      .catch(() => setSet(false));
  }, []);

  async function post(body: { token: string }): Promise<void> {
    setBusy(true);
    try {
      const r = await fetch("/api/instawork/provider", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = (await r.json()) as { set: boolean; probe?: Probe };
      setSet(d.set);
      setProbe(d.probe ?? null);
      setToken("");
      setSavedAt(Date.now());
    } catch {
      /* leave state as-is */
    } finally {
      setBusy(false);
    }
  }

  const justSaved = savedAt != null && Date.now() - savedAt < 2500;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Connect Instawork to reconcile booked temp labor against the schedule. Paste the <strong>cookie</strong> header
        from a logged-in Instawork business tab. Stored write-only — never shown again. Cookies expire, so re-paste it
        if the schedule shows Instawork as unverified. Reads only; posting a gig stays a manual action.
      </p>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Status:</span>
        <span className="font-medium">{set == null ? "…" : set ? "Set" : "Not configured"}</span>
        {probe && (
          <span className={probe.ok ? "text-positive" : "text-red-400"}>
            {probe.ok ? `· reachable (${probe.shifts} shifts)` : `· ${probe.error ?? probe.status}`}
          </span>
        )}
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium">Instawork cookie</label>
        <textarea
          value={token}
          onChange={(e) => setToken(e.target.value)}
          rows={3}
          placeholder={set ? "•••••••• (set — paste to replace)" : "Paste the full cookie header"}
          className="w-full rounded-xl border border-white/10 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || !token.trim()}
          onClick={() => void post({ token })}
          className="btn-hero inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : justSaved ? <Check className="size-4" /> : null}
          {justSaved ? "Saved" : "Save cookie"}
        </button>
        {set && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void post({ token: "__clear__" })}
            className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-4 py-2 text-sm hover:bg-accent disabled:opacity-50"
          >
            <Trash2 className="size-4" /> Clear
          </button>
        )}
      </div>
    </div>
  );
}
