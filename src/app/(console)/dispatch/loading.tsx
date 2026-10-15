// Dispatch is one of the heaviest blades (routes + stops + live data), so instead of the
// bare shared loader it streams a content-shaped skeleton that mirrors the board layout
// (header row + a column of route/stop cards) with the branded loader centred over it.
// Pulses are motion-safe only, colours are Nocturne tokens — see BladeLoading.

import { BladeLoading, SkeletonBlock } from "@/components/BladeLoading";

export default function DispatchLoading() {
  return (
    <main className="p-6">
      {/* Header: title + date controls */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <SkeletonBlock className="h-5 w-40" />
        <SkeletonBlock className="h-8 w-56" />
      </div>

      {/* Route / stop cards */}
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded border border-border bg-panel p-4">
            <div className="flex items-center justify-between gap-4">
              <SkeletonBlock className="h-4 w-48" />
              <SkeletonBlock className="h-4 w-20" />
            </div>
            <div className="mt-3 space-y-2">
              <SkeletonBlock className="h-3 w-full" />
              <SkeletonBlock className="h-3 w-5/6" />
            </div>
          </div>
        ))}
      </div>

      <BladeLoading />
    </main>
  );
}
