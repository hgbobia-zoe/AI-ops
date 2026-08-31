"use client";

import { useState } from "react";
import { Loader2, Play, MapPin, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Stop } from "@/lib/types";

/** Renders the pre-route lifecycle: Start Route, Loading, and the manual fallback. */
export function RouteStartStates({
  phase,
  busy,
  onStart,
  onManualSubmit,
}: {
  phase: "needsStart" | "scraping" | "failed" | "loading";
  busy: boolean;
  onStart: () => void;
  onManualSubmit: (stops: Stop[]) => void;
}) {
  if (phase === "loading") {
    return <Centered icon={<Loader2 className="size-8 animate-spin" />} title="Loading…" />;
  }

  if (phase === "scraping") {
    return (
      <Centered
        icon={<Loader2 className="size-8 animate-spin text-primary" />}
        title="Loading route…"
      >
        Reading today&apos;s stops from Goodshuffle. This takes a moment.
      </Centered>
    );
  }

  if (phase === "needsStart") {
    return (
      <div className="space-y-5">
        <Centered icon={<MapPin className="size-8" />} title="Ready to roll">
          Pull today&apos;s route from Goodshuffle to begin your shift.
        </Centered>
        <button
          onClick={onStart}
          disabled={busy}
          className="btn-hero flex min-h-32 w-full flex-col items-center justify-center gap-2.5 rounded-3xl border-0 transition-all active:scale-[0.98] disabled:opacity-70"
        >
          <Play className="size-9" />
          <span className="text-2xl font-semibold">Start Route</span>
        </button>
      </div>
    );
  }

  // failed → manual entry fallback
  return <ManualEntry onSubmit={onManualSubmit} busy={busy} />;
}

function ManualEntry({
  onSubmit,
  busy,
}: {
  onSubmit: (stops: Stop[]) => void;
  busy: boolean;
}) {
  const [rows, setRows] = useState<{ custName: string; address: string; custPhone: string }[]>([
    { custName: "", address: "", custPhone: "" },
  ]);

  function update(i: number, key: "custName" | "address" | "custPhone", value: string) {
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, [key]: value } : row)));
  }

  const valid = rows.filter((r) => r.custName.trim() && r.address.trim());

  function submit() {
    const stops: Stop[] = valid.map((r, i) => ({
      stopId: `S-${i + 1}`,
      routeId: "",
      customerId: `C-${i + 1}`,
      sequence: i + 1,
      state: "Waiting",
      custName: r.custName.trim(),
      custPhone: r.custPhone.trim(),
      address: r.address.trim(),
    }));
    onSubmit(stops);
  }

  return (
    <div className="space-y-4">
      <Card className="border-white/10 bg-white/[0.03]">
        <CardContent className="flex items-start gap-3 p-4">
          <MapPin className="mt-0.5 size-5 shrink-0 text-primary" />
          <div className="text-sm">
            <div className="font-semibold text-foreground">Enter today&apos;s route</div>
            <div className="text-muted-foreground">
              Add each stop in order — customer, address, phone. These drive the texts,
              ETA, and tracking link.
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-3">
        {rows.map((row, i) => (
          <div key={i} className="space-y-2 rounded-2xl border p-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground">Stop {i + 1}</Label>
              {rows.length > 1 && (
                <button
                  onClick={() => setRows((r) => r.filter((_, idx) => idx !== i))}
                  className="text-muted-foreground hover:text-destructive"
                  aria-label="Remove stop"
                >
                  <Trash2 className="size-4" />
                </button>
              )}
            </div>
            <Input
              placeholder="Customer name"
              value={row.custName}
              onChange={(e) => update(i, "custName", e.target.value)}
            />
            <Input
              placeholder="Address"
              value={row.address}
              onChange={(e) => update(i, "address", e.target.value)}
            />
            <Input
              inputMode="tel"
              placeholder="Phone (optional)"
              value={row.custPhone}
              onChange={(e) => update(i, "custPhone", e.target.value)}
            />
          </div>
        ))}
      </div>

      <Button
        variant="outline"
        onClick={() => setRows((r) => [...r, { custName: "", address: "", custPhone: "" }])}
        className="h-12 w-full gap-2"
      >
        <Plus className="size-4" /> Add stop
      </Button>

      <Button
        onClick={submit}
        disabled={busy || valid.length === 0}
        className="h-14 w-full text-lg"
      >
        Use {valid.length} stop{valid.length === 1 ? "" : "s"}
      </Button>
    </div>
  );
}

function Centered({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <Card className="shadow-sm">
      <CardContent className="flex flex-col items-center gap-3 px-8 py-10 text-center">
        <div className="flex size-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          {icon}
        </div>
        <h1 className="text-xl font-bold">{title}</h1>
        {children && <p className="max-w-sm text-muted-foreground">{children}</p>}
      </CardContent>
    </Card>
  );
}
