"use client";

// Generate + manage Shift Passes: time-limited, revocable, link-based access for contractors / temp
// workers. Create one (name + when it ends, optional phone), copy or text the link via Quo, and revoke
// any pass on the spot. A pass grants a scoped board-only "guest" session — no money, no settings.

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Plus, Copy, Check, Send, Ban, Loader2, Clock, ShieldCheck, Truck, LayoutGrid } from "lucide-react";

type Scope = "driver" | "board";
const SCOPE_LABEL: Record<string, string> = { driver: "Driver (kiosk)", drive: "Driver (kiosk)", board: "Dispatcher (board)" };

interface Pass {
  id: string;
  name: string;
  phone: string | null;
  scope: string;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
  status: "active" | "expired" | "revoked";
  url: string;
}

// Default a new pass to end 8 hours from now, formatted for <input type="datetime-local"> in LOCAL time.
function defaultEnd(): string {
  const d = new Date(Date.now() + 8 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return iso;
  }
}

const STATUS_STYLE: Record<Pass["status"], string> = {
  active: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  expired: "border-white/15 bg-white/5 text-muted-foreground",
  revoked: "border-red-500/30 bg-red-500/10 text-red-300",
};

export function ShiftPassesAdmin(): React.JSX.Element {
  const [passes, setPasses] = useState<Pass[] | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [scope, setScope] = useState<Scope>("driver");
  const [ends, setEnds] = useState(defaultEnd);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justMade, setJustMade] = useState<Pass | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/passes");
      const j = (await r.json()) as { passes: Pass[] };
      setPasses(j.passes ?? []);
    } catch {
      setPasses([]);
    }
  }, []);

  useEffect(() => {
    // Mount fetch via the promise chain (not `await load()`) — the lint rule forbids setState reached
    // synchronously from an effect; behind .then it's asynchronous and fine. Handlers reuse load().
    fetch("/api/passes")
      .then((r) => r.json())
      .then((j: { passes: Pass[] }) => setPasses(j.passes ?? []))
      .catch(() => setPasses([]));
  }, []);

  async function create() {
    setError(null);
    if (!name.trim()) {
      setError("Enter the contractor's name.");
      return;
    }
    const ms = Date.parse(ends);
    if (!Number.isFinite(ms) || ms <= Date.now()) {
      setError("Pick an end time in the future.");
      return;
    }
    setCreating(true);
    try {
      const r = await fetch("/api/passes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), phone: phone.trim() || undefined, scope, expiresAt: new Date(ms).toISOString() }),
      });
      const j = (await r.json()) as { pass?: Pass; error?: string };
      if (!r.ok || !j.pass) {
        setError(j.error === "expiry_in_past" ? "Pick an end time in the future." : "Could not create the pass.");
        return;
      }
      setJustMade(j.pass);
      setName("");
      setPhone("");
      setEnds(defaultEnd());
      await load();
    } catch {
      setError("Could not create the pass — network error.");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    if (!confirm("Revoke this pass now? The contractor loses access on their next screen refresh.")) return;
    await fetch("/api/passes/revoke", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    if (justMade?.id === id) setJustMade(null);
    await load();
  }

  return (
    <main className="mx-auto max-w-3xl p-5 pb-24 md:p-8">
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <KeyRound className="size-7" /> Shift Passes
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Give a temp driver or contractor a link that opens their screen for a single shift — no login. A <b>Driver</b> pass
          opens the kiosk route checklist so they can mark stops en route / arrived / complete and add photos, just like the
          tablet. A <b>Dispatcher</b> pass opens the office board (view). Either expires when you say, can be revoked anytime,
          and never sees money or settings.
        </p>
      </header>

      {/* Create */}
      <section className="surface mb-6 space-y-4 rounded-2xl border border-white/5 p-5">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Plus className="size-4" /> New pass
        </h2>
        <div className="space-y-1.5">
          <span className="text-sm font-medium">Pass type</span>
          <div className="grid gap-2 sm:grid-cols-2">
            {([
              { v: "driver" as Scope, icon: Truck, title: "Driver", sub: "Kiosk route + mark progress" },
              { v: "board" as Scope, icon: LayoutGrid, title: "Dispatcher", sub: "Office board (view only)" },
            ]).map((o) => {
              const active = scope === o.v;
              return (
                <button
                  key={o.v}
                  type="button"
                  onClick={() => setScope(o.v)}
                  className={`flex items-start gap-2.5 rounded-xl border p-3 text-left transition-colors ${
                    active ? "border-foreground bg-foreground/10" : "border-white/10 hover:bg-accent"
                  }`}
                >
                  <o.icon className={`mt-0.5 size-4 shrink-0 ${active ? "" : "text-muted-foreground"}`} />
                  <span>
                    <span className="block text-sm font-medium">{o.title}</span>
                    <span className="block text-xs text-muted-foreground">{o.sub}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1.5">
            <span className="text-sm font-medium">{scope === "board" ? "Dispatcher name" : "Driver name"}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Marcus Bell"
              className="w-full rounded-xl border border-white/10 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-sm font-medium">Access ends</span>
            <input
              type="datetime-local"
              value={ends}
              onChange={(e) => setEnds(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <label className="space-y-1.5 sm:col-span-2">
            <span className="text-sm font-medium">
              Mobile number <span className="font-normal text-muted-foreground">(optional — lets you text the link)</span>
            </span>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(301) 555-0143"
              className="w-full rounded-xl border border-white/10 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          onClick={create}
          disabled={creating}
          className="btn-hero inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium disabled:opacity-50"
        >
          {creating ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
          {creating ? "Generating…" : "Generate pass"}
        </button>

        {justMade && (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
            <div className="mb-2 text-sm font-medium text-emerald-200">
              {SCOPE_LABEL[justMade.scope] ?? "Pass"} ready for {justMade.name} — ends {fmtWhen(justMade.expiresAt)}
            </div>
            <PassLinkRow pass={justMade} onSent={load} />
          </div>
        )}
      </section>

      {/* List */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Passes</h2>
        {passes === null ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : passes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No passes yet. Generate one above.</p>
        ) : (
          passes.map((p) => (
            <div key={p.id} className="surface rounded-2xl border border-white/5 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{p.name}</span>
                  <span className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {p.scope === "board" ? <LayoutGrid className="size-3" /> : <Truck className="size-3" />}
                    {SCOPE_LABEL[p.scope] ?? p.scope}
                  </span>
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize ${STATUS_STYLE[p.status]}`}>{p.status}</span>
                </div>
                {p.status === "active" && (
                  <button
                    onClick={() => revoke(p.id)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 px-2.5 py-1 text-xs text-red-300 hover:bg-red-500/10"
                  >
                    <Ban className="size-3.5" /> Revoke
                  </button>
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-3" /> {p.status === "revoked" ? `revoked ${fmtWhen(p.revokedAt)}` : `ends ${fmtWhen(p.expiresAt)}`}
                </span>
                {p.phone && <span>{p.phone}</span>}
                <span>last used {p.lastSeenAt ? fmtWhen(p.lastSeenAt) : "never"}</span>
                {p.createdBy && <span>by {p.createdBy}</span>}
              </div>
              {p.status === "active" && (
                <div className="mt-3">
                  <PassLinkRow pass={p} onSent={load} />
                </div>
              )}
            </div>
          ))
        )}
      </section>
    </main>
  );
}

// The link + copy + text-via-Quo controls, shared by the fresh-pass callout and each active row.
function PassLinkRow({ pass, onSent }: { pass: Pass; onSent: () => void }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(pass.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — the field is selectable */
    }
  }

  async function text() {
    setErr(null);
    setSent(null);
    setSending(true);
    try {
      const r = await fetch("/api/passes/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: pass.id }) });
      const j = (await r.json()) as { ok?: boolean; to?: string; error?: string; disabled?: boolean };
      if (j.ok) {
        setSent(`Texted to ${j.to}`);
        onSent();
      } else {
        setErr(j.error ?? "Could not send.");
      }
    } catch {
      setErr("Could not send — network error.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          readOnly
          value={pass.url}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-background px-3 py-1.5 font-mono text-xs"
        />
        <button onClick={copy} className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-2.5 py-1.5 text-xs hover:bg-accent">
          {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
        {pass.phone && (
          <button
            onClick={text}
            disabled={sending}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
          >
            {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
            Text link
          </button>
        )}
      </div>
      {sent && <p className="text-xs text-emerald-400">{sent}</p>}
      {err && <p className="text-xs text-red-400">{err}</p>}
    </div>
  );
}
