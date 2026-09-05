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

// Kept for API compatibility with callers; the field flow confirms proof was
// captured (photos + signature checks below) rather than uploading it here, so
// these refs stay empty.
export interface ProofRefs {
  photoIds?: string[];
  signatureId?: string;
}

// The pre-departure checklist the driver confirms before leaving each stop. Order
// mirrors the on-site sequence: count/test → photograph → get signature → tidy up.
type CheckKey = "equipment" | "photos" | "signed" | "siteClean";
const ITEMS: { key: CheckKey; label: string }[] = [
  { key: "equipment", label: "Equipment counted and tested" },
  { key: "photos", label: "Delivery photos taken" },
  { key: "signed", label: "Customer signature collected" },
  { key: "siteClean", label: "Site left clean" },
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
  const [checks, setChecks] = useState<Record<CheckKey, boolean>>({
    equipment: false,
    photos: false,
    signed: false,
    siteClean: false,
  });
  const [reason, setReason] = useState("");

  const allChecked = Object.values(checks).every(Boolean);
  const needsReason = !allChecked;
  const canConfirm = allChecked || reason.trim().length > 0;

  function toggle(key: CheckKey) {
    setChecks((c) => ({ ...c, [key]: !c[key] }));
  }

  function reset() {
    setChecks({ equipment: false, photos: false, signed: false, siteClean: false });
    setReason("");
  }

  function handleConfirm() {
    if (!canConfirm) return;
    onConfirm({
      signed: checks.signed,
      photos: checks.photos,
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
                placeholder="e.g. Customer not on site to sign"
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
