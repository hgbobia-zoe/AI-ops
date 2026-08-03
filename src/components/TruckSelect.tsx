"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Truck, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { bindTruck } from "@/lib/device";
import { fetchVehicles } from "@/lib/tablesRead";
import { appConfig } from "@/lib/config";
import type { Vehicle } from "@/lib/types";

export function TruckSelect() {
  const router = useRouter();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Vehicle | null>(null);
  const [pin, setPin] = useState("");

  useEffect(() => {
    fetchVehicles()
      .then(setVehicles)
      .catch(() => setError("Could not load trucks."))
      .finally(() => setLoading(false));
  }, []);

  function confirmBind() {
    if (!picked) return;
    bindTruck(picked.truckId, picked.name, pin || undefined);
    router.push("/kiosk");
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center p-6">
      <div className="mb-10 flex flex-col items-center text-center">
        <span className="btn-hero mb-4 flex size-16 items-center justify-center rounded-2xl text-white">
          <Truck className="size-8" />
        </span>
        <h1 className="text-3xl font-bold tracking-tight">{appConfig.name}</h1>
        <p className="mt-1.5 text-muted-foreground">
          Select the truck assigned to this tablet
        </p>
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" /> Loading trucks…
        </div>
      )}
      {error && <p className="text-center text-destructive">{error}</p>}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {vehicles.map((v) => (
          <button
            key={v.truckId}
            onClick={() => {
              setPin("");
              setPicked(v);
            }}
            className="surface group flex h-32 flex-col items-center justify-center gap-2 rounded-2xl border border-white/5 transition-all hover:border-primary/40 hover:-translate-y-0.5 active:scale-[0.97]"
          >
            <span className="flex size-11 items-center justify-center rounded-xl bg-primary/15 text-primary transition-colors group-hover:bg-primary/25">
              <Truck className="size-6" />
            </span>
            <span className="text-xl font-bold">{v.name}</span>
            {v.plate && (
              <span className="text-xs text-muted-foreground">{v.plate}</span>
            )}
          </button>
        ))}
      </div>

      <Dialog open={picked !== null} onOpenChange={(o) => !o && setPicked(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Use {picked?.name} on this tablet?</DialogTitle>
            <DialogDescription>
              This tablet will stay bound to {picked?.name} until you change it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="pin">Lock PIN (optional)</Label>
            <Input
              id="pin"
              inputMode="numeric"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="Prevents accidental truck changes"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPicked(null)} className="h-12">
              Cancel
            </Button>
            <Button onClick={confirmBind} className="h-12">
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
