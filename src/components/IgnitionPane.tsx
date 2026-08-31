"use client";

// The Ignition (fleet telematics) pane shown beside the dispatch dashboard — the
// same split-view treatment Goodshuffle gets beside the delivery app.
//
//  • Electron dashboard shell  → a <webview> (first-party, so Ignition's login works
//    and persists).
//  • header-stripping / forceEmbed → an <iframe>.
//  • plain browser             → a tiled separate window (many telematics apps block
//    iframing).
//
// url + forceEmbed come from the server (runtime IGNITION_URL / IGNITION_EMBED), so
// the pane needs no build-time config.

import { createElement } from "react";
import { ExternalLink, Gauge } from "lucide-react";
import { Button } from "@/components/ui/button";
import { gsproWebview, IGNITION_PARTITION, openExternalWindow, shellEmbedFlag } from "@/lib/kiosk";

export function IgnitionPane({ url, forceEmbed }: { url: string; forceEmbed: boolean }) {
  if (gsproWebview()) {
    return createElement("webview", {
      src: url,
      partition: IGNITION_PARTITION,
      allowpopups: "true",
      className: "h-full w-full border-0",
    });
  }

  if (forceEmbed || shellEmbedFlag()) {
    return <iframe title="Ignition" src={url} className="h-full w-full border-0" />;
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 p-8 text-center">
      <span className="flex size-16 items-center justify-center rounded-2xl bg-primary/15 text-primary">
        <Gauge className="size-8" />
      </span>
      <h2 className="text-2xl font-bold">Ignition</h2>
      <p className="max-w-sm text-muted-foreground">
        Live fleet tracking lives in Ignition. It opens as its own window — snap it
        beside this dashboard.
      </p>
      <Button
        onClick={() => openExternalWindow(url, "ignition")}
        className="h-14 gap-2 rounded-xl px-8 text-lg"
      >
        <ExternalLink className="size-5" /> Open Ignition window
      </Button>
      <p className="max-w-xs text-xs text-muted-foreground">
        Desktop: <strong>Win + ←</strong> on the Ignition window, then{" "}
        <strong>Win + →</strong> here.
      </p>
    </div>
  );
}
