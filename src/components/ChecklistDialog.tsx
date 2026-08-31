"use client";

import { useState } from "react";
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

// Kept for API compatibility with callers; proof-of-delivery capture (photos +
// signature) was removed from the driver flow, so this is always empty now.
export interface ProofRefs {
  photoIds?: string[];
  signatureId?: string;
}

const ITEMS: { key: "equipment" | "siteClean"; label: string }[] = [
  { key: "equipment", label: "Equipment counted" },
  { key: "siteClean", label: "Site clean" },
];

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
  const [checks, setChecks] = useState({ equipment: false, siteClean: false });
  const [reason, setReason] = useState("");

  const allChecked = Object.values(checks).every(Boolean);
  const needsReason = !allChecked;
  const canConfirm = allChecked || reason.trim().length > 0;

  function toggle(key: keyof typeof checks) {
    setChecks((c) => ({ ...c, [key]: !c[key] }));
  }

  function reset() {
    setChecks({ equipment: false, siteClean: false });
    setReason("");
  }

  function handleConfirm() {
    if (!canConfirm) return;
    // signed/photos are no longer captured in the field; report them as satisfied
    // so they never trigger an override reason.
    onConfirm({
      signed: true,
      photos: true,
      equipment: checks.equipment,
      siteClean: checks.siteClean,
      overrideReason: needsReason ? reason.trim() : undefined,
    });
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
                placeholder="e.g. Equipment count pending"
                rows={2}
              />
            </div>
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
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
