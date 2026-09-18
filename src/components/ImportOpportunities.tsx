"use client";

// Manual import — paste CSV (from a spreadsheet, Apify export, or your own research) to feed REAL
// opportunities into the radar. No API key or scraper required.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Upload, Download } from "lucide-react";
import { toast } from "sonner";

export function ImportOpportunities({ template }: { template: string }) {
  const router = useRouter();
  const [csv, setCsv] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ parsed: number; stored: number; errors: string[] } | null>(null);

  async function submit() {
    if (!csv.trim()) { toast.error("Paste CSV rows first"); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/radar/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ csv, label: label.trim() || "paste" }) });
      const data = (await res.json()) as { parsed?: number; stored?: number; errors?: string[]; error?: string };
      if (!res.ok) throw new Error(data.error);
      setResult({ parsed: data.parsed ?? 0, stored: data.stored ?? 0, errors: data.errors ?? [] });
      toast.success(`Imported ${data.stored} opportunit${data.stored === 1 ? "y" : "ies"}`);
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message || "Import failed");
    } finally {
      setBusy(false);
    }
  }

  function downloadTemplate() {
    const blob = new Blob([template], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "opportunity-import-template.csv"; a.click(); URL.revokeObjectURL(url);
  }

  return (
    <div className="rounded border border-border p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Source label (e.g. Convention center calendar)" className="w-72 rounded border border-border bg-transparent px-2.5 py-1 text-[12.5px] text-foreground placeholder:text-meta" />
        <button onClick={downloadTemplate} className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[12px] text-tertiary-text hover:bg-[var(--row-hover)] hover:text-foreground"><Download className="size-3.5" /> Template</button>
      </div>
      <textarea
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
        rows={10}
        placeholder="Paste CSV here (first row = headers). Download the template for the columns."
        className="w-full rounded border border-border bg-transparent px-2.5 py-2 font-mono text-[12px] text-secondary-text placeholder:text-meta"
      />
      <div className="mt-2 flex items-center gap-3">
        <button onClick={submit} disabled={busy} className="inline-flex items-center gap-2 rounded border border-foreground/25 bg-foreground/[0.06] px-3 py-1.5 text-[12.5px] font-medium text-foreground hover:bg-foreground/[0.12] disabled:opacity-50"><Upload className="size-3.5" /> {busy ? "Importing…" : "Import"}</button>
        {result && <span className="text-[12.5px] text-meta">Parsed {result.parsed}, stored {result.stored}{result.errors.length ? `, ${result.errors.length} error(s)` : ""}.</span>}
      </div>
      {result && result.errors.length > 0 && <ul className="mt-2 space-y-0.5 text-[11.5px] text-critical">{result.errors.slice(0, 5).map((e, i) => <li key={i}>· {e}</li>)}</ul>}
    </div>
  );
}
