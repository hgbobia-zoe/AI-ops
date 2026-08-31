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
import { SignaturePad } from "@/components/SignaturePad";
import type { ChecklistResult } from "@/lib/types";

export interface ProofRefs {
  photoIds?: string[];
  signatureId?: string;
}

const ITEMS: { key: keyof Omit<ChecklistResult, "overrideReason">; label: string }[] = [
  { key: "signed", label: "Customer signed" },
  { key: "photos", label: "Photos taken" },
  { key: "equipment", label: "Equipment counted" },
  { key: "siteClean", label: "Site clean" },
];

// Downscale a captured photo before upload so field uploads stay small/fast.
async function fileToDataUrl(file: File, max = 1280, quality = 0.7): Promise<string> {
  const dataUrl = await new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result as string);
    fr.onerror = () => rej(new Error("read failed"));
    fr.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("decode failed"));
    i.src = dataUrl;
  });
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  if (scale >= 1) return dataUrl;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

async function uploadProof(photos: string[], signature: string | null): Promise<ProofRefs> {
  if (!photos.length && !signature) return {};
  const r = await fetch("/api/pod", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ photos, signature }),
  });
  if (!r.ok) throw new Error("upload failed");
  return (await r.json()) as ProofRefs;
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
  const [checks, setChecks] = useState({
    signed: false,
    photos: false,
    equipment: false,
    siteClean: false,
  });
  const [reason, setReason] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [signature, setSignature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadFailed, setUploadFailed] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const allChecked = Object.values(checks).every(Boolean);
  const needsReason = !allChecked;
  const canConfirm = (allChecked || reason.trim().length > 0) && !busy;

  function toggle(key: keyof typeof checks) {
    setChecks((c) => ({ ...c, [key]: !c[key] }));
  }

  async function addPhotos(files: FileList | null) {
    if (!files?.length) return;
    const added: string[] = [];
    for (const f of Array.from(files)) {
      try {
        added.push(await fileToDataUrl(f));
      } catch {
        /* skip unreadable file */
      }
    }
    if (added.length) {
      setPhotos((p) => [...p, ...added]);
      setChecks((c) => ({ ...c, photos: true })); // auto-satisfy the checklist item
    }
  }

  function onSignature(dataUrl: string | null) {
    setSignature(dataUrl);
    if (dataUrl) setChecks((c) => ({ ...c, signed: true }));
  }

  function reset() {
    setChecks({ signed: false, photos: false, equipment: false, siteClean: false });
    setReason("");
    setPhotos([]);
    setSignature(null);
    setUploadFailed(false);
  }

  async function handleConfirm() {
    if (!canConfirm) return;
    setBusy(true);
    let proof: ProofRefs = {};
    try {
      proof = await uploadProof(photos, signature);
    } catch {
      // Never block a completion on a flaky upload — proceed, flag it.
      setUploadFailed(true);
    }
    setBusy(false);
    onConfirm(
      { ...checks, overrideReason: needsReason ? reason.trim() : undefined },
      proof,
    );
    reset();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Before you leave</DialogTitle>
          <DialogDescription>
            Capture proof of delivery, then confirm each item. Anything unchecked
            needs a reason (sent to Slack).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Proof of delivery — photos */}
          <div className="space-y-2">
            <Label className="text-foreground">Delivery photos</Label>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              hidden
              onChange={(e) => void addPhotos(e.target.files)}
            />
            <div className="flex flex-wrap gap-2">
              {photos.map((src, i) => (
                <div key={i} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt="" className="size-16 rounded-md object-cover" />
                  <button
                    type="button"
                    onClick={() => setPhotos((p) => p.filter((_, j) => j !== i))}
                    className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-foreground text-background"
                    aria-label="Remove photo"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="flex size-16 flex-col items-center justify-center gap-1 rounded-md border border-dashed text-muted-foreground active:bg-accent"
              >
                <Camera className="size-5" />
                <span className="text-[10px]">Add</span>
              </button>
            </div>
          </div>

          {/* Proof of delivery — signature */}
          <div className="space-y-1.5">
            <Label className="text-foreground">Customer signature</Label>
            <SignaturePad onChange={onSignature} />
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
                placeholder="e.g. Customer waived signature"
                rows={2}
              />
            </div>
          )}

          {uploadFailed && (
            <p className="text-sm text-destructive">
              Proof couldn&apos;t be uploaded (offline?) — the stop was still completed.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="h-12 text-base"
          >
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!canConfirm} className="h-12 text-base">
            {busy ? "Saving…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
