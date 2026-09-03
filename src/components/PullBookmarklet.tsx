"use client";

// Renders the office pull as an installable bookmarklet. React strips `javascript:` hrefs from
// JSX for XSS safety, so we set the draggable link's href imperatively via a ref. Also offers a
// copy button as a fallback for browsers/policies that block dragging.

import { useEffect, useRef, useState } from "react";
import { Bookmark, Copy, Check } from "lucide-react";

export function PullBookmarklet({ script }: { script: string }): React.JSX.Element {
  const ref = useRef<HTMLAnchorElement>(null);
  const [copied, setCopied] = useState(false);
  const href = "javascript:" + encodeURIComponent(script);

  // Set the javascript: href outside React's JSX sanitizer.
  useEffect(() => {
    if (ref.current) ref.current.setAttribute("href", href);
  }, [href]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — user can still drag the button */
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a
        ref={ref}
        href="#"
        draggable
        onClick={(e) => e.preventDefault()}
        className="btn-hero inline-flex cursor-grab items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold active:cursor-grabbing"
        title="Drag me to your bookmarks bar"
      >
        <Bookmark className="size-4" /> Pull Zoe Routes
      </a>
      <button
        type="button"
        onClick={copy}
        className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
      >
        {copied ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4" />}
        {copied ? "Copied" : "Copy bookmarklet"}
      </button>
    </div>
  );
}
