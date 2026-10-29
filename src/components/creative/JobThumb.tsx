"use client";

// A stable, correctly-shaped thumbnail frame for one creative job.
//
// The frame reserves space from the asset's aspect ratio BEFORE the image loads, so the grid never
// reflows (no layout shift) and portrait/wide assets both sit in a frame of the right shape. The image is
// lazy-loaded and decoded async, and we never fetch a full-size original eagerly — tiles below the fold
// load only as they scroll in. When there is no preview, or the image 404s / fails to decode, we show an
// honest fallback (never a blank or a fake image). Generated placeholders are badged as such.

import { useState } from "react";
import { ImageOff, ImageIcon } from "lucide-react";
import { aspectCss, type AspectRatio } from "@/lib/creative/types";
import type { ThumbOrigin } from "@/lib/creative/jobView";

export function JobThumb({
  src,
  ratio,
  alt,
  placeholder = false,
  origin,
  rounded = "rounded-md",
  className = "",
}: {
  src: string | null;
  ratio: AspectRatio;
  alt: string;
  placeholder?: boolean;
  origin?: ThumbOrigin;
  rounded?: string;
  className?: string;
}): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  const showImage = !!src && !failed;

  return (
    <div
      className={`relative overflow-hidden border border-border bg-row ${rounded} ${className}`}
      style={{ aspectRatio: aspectCss(ratio) }}
    >
      {showImage ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src!}
            alt={alt}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
            className="absolute inset-0 size-full object-cover"
          />
          {placeholder && (
            <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-[0.04em] text-white">
              Placeholder
            </span>
          )}
          {origin === "source" && (
            <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-[0.04em] text-white">
              Source photo
            </span>
          )}
        </>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-meta">
          {src && failed ? <ImageOff className="size-5" aria-hidden /> : <ImageIcon className="size-5" aria-hidden />}
          <span className="text-[10.5px]">{src && failed ? "Preview unavailable" : "No preview yet"}</span>
        </div>
      )}
    </div>
  );
}
