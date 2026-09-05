"use client";

import { useRef, useState } from "react";
import { Camera, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ChecklistResult } from "@/lib/types";

// Proof-of-delivery photos are captured HERE (camera) and saved to /api/pod on confirm; the returned
// ids ride the completion action → attach to the stop AND queue a push into the Goodshuffle Files tab.
export interface ProofRefs {
  photoIds?: string[];
  signatureId?: string;
}

// Plain confirm items (yes/no). Photos are handled separately as a real camera capture.
type CheckKey = "equipment" | "signed" | "siteClean";
const ITEMS: { key: CheckKey; label: string }[] = [
  { key: "equipment", label: "Equipment counted and tested" },
  { key: "signed", label: "Customer signature collected (in Goodshuffle)" },
  { key: "siteClean", label: "Site left clean" },
];

// Downscale a captured photo to a sane size before upload (phones shoot 3–8MB; Goodshuffle caps at
// 8MB and the push is faster small). Longest edge ≤ 1600px, JPEG q0.82. Falls back to the raw data URL.
function downscale(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result);
      const img = new Image();
      img.onload = () => {
        const max = 1600;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(src);
        ctx.drawImage(img, 0, 0, w, h);
        try {
          resolve(canvas.toDataURL("image/jpeg", 0.82));
        } catch {
          resolve(src);
        }
      };
      img.onerror = () => resolve(src);
      img.src = src;
    };
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });
}

export function ChecklistDialog({
  open,
  onOpenChange,
  onConfirm,
  confirmLabel = "Confirm",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (result: ChecklistResult, proof?: ProofRefs) => void;
  confirmLabel?: string;
}) {
  const [checks, setChecks] = useState<Record<CheckKey, boolean>>({ equipment: false, signed: false, siteClean: false });
  const [photos, setPhotos] = useState<string[]>([]); // data URLs
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const allChecked = checks.equipment && checks.signed && checks.siteClean && photos.length > 0;
  const needsReason = !allChecked;
  const canConfirm = !saving && (allChecked || reason.trim().length > 0);

  function toggle(key: CheckKey) {
    setChecks((c) => ({ ...c, [key]: !c[key] }));
  }

  async function addPhotos(files: FileList | null) {
    if (!files?.length) return;
    const added = await Promise.all(Array.from(files).map(downscale));
    setPhotos((p) => [...p, ...added.filter(Boolean)]);
    if (fileRef.current) fileRef.current.value = ""; // allow re-selecting the same shot
  }

  function reset() {
    setChecks({ equipment: false, signed: false, siteClean: false });
    setPhotos([]);
    setReason("");
    setError(null);
  }

  async function handleConfirm() {
    if (!canConfirm) return;
    setError(null);
    let photoIds: string[] | undefined;
    if (photos.length > 0) {
      setSaving(true);
      try {
        const res = await fetch("/api/pod", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ photos }),
        });
        const data = (await res.json().catch(() => null)) as { photoIds?: string[] } | null;
        if (!res.ok || !data?.photoIds?.length) {
          setSaving(false);
          setError("Couldn't save the photos — check signal and try again.");
          return; // never leave with lost proof
        }
        photoIds = data.photoIds;
      } catch {
        setSaving(false);
        setError("Couldn't save the photos — check signal and try again.");
        return;
      }
      setSaving(false);
    }

    onConfirm(
      {
        signed: checks.signed,
        photos: photos.length > 0,
        equipment: checks.equipment,
        siteClean: checks.siteClean,
        overrideReason: needsReason ? reason.trim() : undefined,
      },
      photoIds ? { photoIds } : undefined,
    );
    reset();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Before you leave</DialogTitle>
          <DialogDescription>
            Confirm each item. Anything unchecked needs a reason (sent to Slack).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Delivery photos — captured right here, required (or a reason). */}
          <div className="rounded-lg border p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-3 text-lg">
                <Checkbox checked={photos.length > 0} disabled className="size-6" />
                Delivery photos{photos.length ? ` (${photos.length})` : ""}
              </span>
              <Button
                type="button"
                variant="outline"
                onClick={() => fileRef.current?.click()}
                className="h-11 gap-2"
              >
                <Camera className="size-5" /> {photos.length ? "Add" : "Take photo"}
              </Button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              hidden
              onChange={(e) => void addPhotos(e.target.files)}
            />
            {photos.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {photos.map((src, i) => (
                  <div key={i} className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={src} alt={`delivery ${i + 1}`} className="size-16 rounded-md object-cover" />
                    <button
                      type="button"
                      onClick={() => setPhotos((p) => p.filter((_, j) => j !== i))}
                      aria-label="Remove photo"
                      className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-black/80 text-white"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {ITEMS.map((item) => (
            <label
              key={item.key}
              className="flex items-center gap-3 rounded-lg border p-4 text-lg active:bg-accent"
            >
              <Checkbox
                checked={checks[item.key]}
                onCheckedChange={() => toggle(item.key)}
                className="size-6"
              />
              <span>{item.label}</span>
            </label>
          ))}

          {needsReason && (
            <div className="space-y-2">
              <Label htmlFor="override-reason" className="text-foreground">
                Reason for override (required)
              </Label>
              <Textarea
                id="override-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. No delivery photos — customer took the items at our dock"
                rows={2}
              />
            </div>
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="h-12 text-base"
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!canConfirm} className="h-12 text-base">
            {saving ? "Saving photos…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
