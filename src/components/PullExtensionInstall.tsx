"use client";

// "Install the Auto-Pull extension here" — the office-machine one-time setup. Chrome can't install an
// unpacked extension with a single click (a security rule), so the honest flow is: download the zip,
// unzip, and Load unpacked. This gives the download button + the exact steps, with copy helpers for
// the chrome://extensions URL (which can't be a normal link).

import { useState } from "react";
import { Download, Copy, Check, Puzzle } from "lucide-react";

export function PullExtensionInstall({ downloadHref }: { downloadHref: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText("chrome://extensions");
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — the text is shown anyway */
    }
  };

  return (
    <div className="space-y-3">
      <a
        href={downloadHref}
        download
        className="btn-hero inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold"
      >
        <Download className="size-4" /> Install extension here (download .zip)
      </a>

      <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
        <li>The download is <b>zoe-autopull-extension.zip</b> — <b>unzip</b> it to a folder you&apos;ll keep (e.g. Documents).</li>
        <li>
          Open a new tab and go to{" "}
          <code className="rounded bg-white/10 px-1.5 py-0.5 text-foreground">chrome://extensions</code>
          <button onClick={copy} className="ml-1.5 inline-flex items-center gap-1 rounded border border-white/15 px-1.5 py-0.5 text-[11px] hover:bg-white/5">
            {copied ? <><Check className="size-3" /> copied</> : <><Copy className="size-3" /> copy</>}
          </button>{" "}
          (paste it in the address bar — it can&apos;t be a clickable link).
        </li>
        <li>Turn on <b>Developer mode</b> (top-right toggle).</li>
        <li>Click <b>Load unpacked</b> and choose the folder you just unzipped.</li>
        <li>
          <span className="inline-flex items-center gap-1"><Puzzle className="size-3.5" /> &ldquo;Zoe Auto-Pull&rdquo;</span> appears. That&apos;s it — with
          <b> pro.goodshuffle.com</b> open and signed in, it pulls every 10 minutes automatically. Click its toolbar icon to
          see status or pull now.
        </li>
      </ol>

      <p className="text-[12px] text-muted-foreground">
        Do this on the <b>office machine only</b> — the one that stays logged into Goodshuffle. The pull feeds the whole
        team; nobody else needs to install anything. Use the same browser that&apos;s signed into GSPRO.
      </p>
    </div>
  );
}
