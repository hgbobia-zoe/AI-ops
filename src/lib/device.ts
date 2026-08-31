// Per-tablet device binding. Drivers do not log in — the tablet is bound once to
// a truck and remembers it. Switching trucks is done from the header menu.

"use client";

import { appConfig } from "./config";

export interface TruckBinding {
  truckId: string;
  name: string;
  boundAt: string; // ISO8601
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

export function bindTruck(truckId: string, name: string): TruckBinding {
  const binding: TruckBinding = {
    truckId,
    name,
    boundAt: new Date().toISOString(),
  };
  window.localStorage.setItem(appConfig.storage.truck, JSON.stringify(binding));
  return binding;
}

export function clearTruck(): void {
  window.localStorage.removeItem(appConfig.storage.truck);
}
