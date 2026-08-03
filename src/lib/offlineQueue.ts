// Offline action queue. Trucks hit dead zones; a button press must never be lost.
// Actions that fail to reach the server are persisted to localStorage and replayed
// on reconnect. Idempotency keys make replay safe — the intake dedupes.

"use client";

import { appConfig } from "./config";
import type { ActionRequest } from "./types";

function read(): ActionRequest[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(appConfig.storage.queue);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ActionRequest[];
  } catch {
    return [];
  }
}

function write(items: ActionRequest[]): void {
  window.localStorage.setItem(appConfig.storage.queue, JSON.stringify(items));
}

export function enqueue(req: ActionRequest): void {
  const items = read();
  if (items.some((i) => i.idempotencyKey === req.idempotencyKey)) return;
  items.push(req);
  write(items);
}

export function dequeue(idempotencyKey: string): void {
  write(read().filter((i) => i.idempotencyKey !== idempotencyKey));
}

export function queued(): ActionRequest[] {
  return read();
}

export function queueSize(): number {
  return read().length;
}
