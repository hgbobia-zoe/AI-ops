// Scheduling is a heavy blade (route demand + roster + Connecteam/Instawork reconcile), so
// it streams a content-shaped skeleton that mirrors the plan layout (header + a grid of
// shift/route cards) with the branded loader centred over it. Pulses are motion-safe only,
// colours are Nocturne tokens — see BladeLoading.

import { BladeLoading, SkeletonBlock } from "@/components/BladeLoading";

export default function SchedulingLoading() {
  return (
    <main className="p-6">
      {/* Header: title + plan summary pills */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <SkeletonBlock className="h-5 w-44" />
        <div className="flex gap-2">
          <SkeletonBlock className="h-8 w-28" />
          <SkeletonBlock className="h-8 w-28" />
        </div>
      </div>

      {/* Shift / route card grid */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded border border-border bg-panel p-4">
            <SkeletonBlock className="h-4 w-32" />
            <div className="mt-3 space-y-2">
              <SkeletonBlock className="h-3 w-full" />
              <SkeletonBlock className="h-3 w-4/5" />
              <SkeletonBlock className="h-3 w-2/3" />
            </div>
          </div>
        ))}
      </div>

      <BladeLoading />
    </main>
  );
}
