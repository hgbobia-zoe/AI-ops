"use client";

// Marketing channel hub — quick-launch links to the tools the team actually runs (Confluence for
// content planning, the social poster, ManyChat, Google Business, directories). One click to jump out;
// an inline editor to keep the links current. The app is the operating dashboard over these tools.

import { useState } from "react";
import { ExternalLink, Pencil, Check, Loader2, X } from "lucide-react";
import { CHANNEL_LINK_FIELDS, emptyChannelLinks, type ChannelLinks } from "@/lib/marketing/types";

export function ChannelHub({ initial }: { initial: ChannelLinks }): React.JSX.Element {
  const [links, setLinks] = useState<ChannelLinks>({ ...emptyChannelLinks(), ...initial });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ChannelLinks>(links);
  const [saving, setSaving] = useState(false);

  const configured = CHANNEL_LINK_FIELDS.filter((f) => links[f.key]?.trim());

  async function save() {
    setSaving(true);
    try {
      const r = await fetch("/api/marketing/links", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
      const j = (await r.json()) as { links?: ChannelLinks };
      if (j.links) setLinks(j.links);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded border border-border p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[13px] font-medium text-foreground">Channel hub</h3>
        {!editing ? (
          <button onClick={() => { setDraft(links); setEditing(true); }} className="inline-flex items-center gap-1 text-[12px] text-meta transition-colors hover:text-foreground"><Pencil className="size-3" /> Edit links</button>
        ) : (
          <div className="flex items-center gap-2">
            <button onClick={() => setEditing(false)} className="inline-flex items-center gap-1 text-[12px] text-meta hover:text-foreground"><X className="size-3" /> Cancel</button>
            <button onClick={save} disabled={saving} className="inline-flex items-center gap-1 text-[12px] font-medium text-foreground disabled:opacity-50">{saving ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} Save</button>
          </div>
        )}
      </div>

      {editing ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {CHANNEL_LINK_FIELDS.map((f) => (
            <label key={f.key} className="space-y-1">
              <span className="text-[11px] text-meta">{f.label}{f.hint && <span className="ml-1 text-meta/70">· {f.hint}</span>}</span>
              <input
                value={draft[f.key]}
                onChange={(e) => setDraft((prev) => ({ ...prev, [f.key]: e.target.value }))}
                placeholder="https://…"
                className="w-full rounded border border-border bg-background px-2 py-1 text-[12.5px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </label>
          ))}
        </div>
      ) : configured.length === 0 ? (
        <p className="text-[12px] text-meta">No tools linked yet. Add your Confluence board, social poster, ManyChat, and Google Business Profile so the team can jump straight to them.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {configured.map((f) => (
            <a key={f.key} href={links[f.key]} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">
              {f.label} <ExternalLink className="size-3" />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
