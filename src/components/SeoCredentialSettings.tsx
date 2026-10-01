"use client";

// Ubersuggest MCP credential — the write-only provider field in /admin. Mirrors the creative provider pattern:
// the actual token is NEVER sent back to the browser; GET reports only whether it is set plus the current
// health, and POST stores or clears it (owner/admin, enforced server-side). After setting, the server probes
// once so the health flips from "Not checked" to the real state.

import { useEffect, useState } from "react";
import { Loader2, Check, Trash2 } from "lucide-react";
import type { SeoHealth } from "@/lib/seo/types";

export function SeoCredentialSettings(): React.JSX.Element {
  const [set, setSet] = useState<boolean | null>(null);
  const [health, setHealth] = useState<SeoHealth | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/seo/provider")
      .then((r) => r.json())
      .then((d: { set: boolean; health: SeoHealth }) => {
        setSet(d.set);
        setHealth(d.health);
      })
      .catch(() => setSet(false));
  }, []);

  async function post(body: { token: string }): Promise<void> {
    setBusy(true);
    try {
      const r = await fetch("/api/seo/provider", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = (await r.json()) as { set: boolean; health: SeoHealth };
      setSet(d.set);
      setHealth(d.health);
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
        Connect the Ubersuggest MCP (Neil Patel) to enable keyword research for the SEO Growth engine. The token is
        stored write-only — it is never shown again. No SEO data is pulled until this is set.
      </p>

      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Status:</span>
        <span className="font-medium">
          {set == null ? "…" : set ? health?.headline ?? "Set" : "Not configured"}
        </span>
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium">Ubersuggest MCP token</label>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={set ? "•••••••• (set — type to replace)" : "Paste the MCP access token"}
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
          {justSaved ? "Saved" : "Save token"}
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
