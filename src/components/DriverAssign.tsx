"use client";

// Assign a driver to a route from the dispatch board — pick from that day's Connecteam
// drivers. This is the Dispatch side of the staffing model the Event Risk Engine validates.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { UserRound, ChevronDown } from "lucide-react";

interface Driver {
  userId: string;
  name: string;
}

export function DriverAssign({
  routeId,
  date,
  driverName,
}: {
  routeId: string;
  date: string;
  driverName?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [drivers, setDrivers] = useState<Driver[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function openMenu() {
    setOpen((v) => !v);
    if (drivers) return;
    try {
      const j = (await fetch(`/api/crew/drivers?date=${date}`).then((r) => r.json())) as {
        drivers?: Driver[];
        configured?: boolean;
      };
      setDrivers(j.drivers ?? []);
      if (!j.configured) setNote("Connecteam not connected");
      else if ((j.drivers ?? []).length === 0) setNote("No drivers scheduled this day");
    } catch {
      setNote("Couldn't load drivers");
    }
  }

  async function assign(d: Driver | null) {
    setBusy(true);
    try {
      await fetch("/api/route/driver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routeId, driverId: d?.userId ?? null, driverName: d?.name ?? null }),
      });
      router.refresh();
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  return (
    <div className="relative">
      <button
        onClick={openMenu}
        disabled={busy}
        className="inline-flex items-center gap-1.5 border border-white/15 px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
      >
        <UserRound className="size-3.5" />
        {driverName ? `Driver: ${driverName}` : "Assign driver"}
        <ChevronDown className="size-3" />
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 max-h-64 w-56 overflow-auto border border-white/15 bg-black p-1 text-sm shadow-lg">
          {drivers === null ? (
            <div className="px-2 py-1.5 text-muted-foreground">Loading…</div>
          ) : (
            <>
              {driverName && (
                <button
                  onClick={() => assign(null)}
                  className="block w-full px-2 py-1.5 text-left text-red-300 hover:bg-white/5"
                >
                  Clear assignment
                </button>
              )}
              {drivers.map((d) => (
                <button
                  key={d.userId}
                  onClick={() => assign(d)}
                  className="block w-full px-2 py-1.5 text-left hover:bg-white/5"
                >
                  {d.name}
                </button>
              ))}
              {drivers.length === 0 && <div className="px-2 py-1.5 text-muted-foreground">{note ?? "No drivers"}</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
