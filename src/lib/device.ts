// Per-tablet device binding. Drivers do not log in — the tablet is bound once to
// a truck and remembers it. A short PIN can lock the binding so a stray tap can't
// silently switch trucks mid-route.

"use client";

import { appConfig } from "./config";

export interface TruckBinding {
  truckId: string;
  name: string;
  boundAt: string; // ISO8601
  pin?: string; // optional lock; empty means unlocked
}

export function getBoundTruck(): TruckBinding | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(appConfig.storage.truck);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TruckBinding;
  } catch {
    return null;
  }
}

export function bindTruck(truckId: string, name: string, pin?: string): TruckBinding {
  const binding: TruckBinding = {
    truckId,
    name,
    boundAt: new Date().toISOString(),
    pin: pin || undefined,
  };
  window.localStorage.setItem(appConfig.storage.truck, JSON.stringify(binding));
  return binding;
}

/** Returns true if the PIN matches (or no PIN is set). */
export function verifyPin(pin: string): boolean {
  const b = getBoundTruck();
  if (!b?.pin) return true;
  return b.pin === pin;
}

export function clearTruck(): void {
  window.localStorage.removeItem(appConfig.storage.truck);
}
