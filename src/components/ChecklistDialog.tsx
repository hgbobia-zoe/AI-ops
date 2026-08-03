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

const ITEMS: { key: keyof Omit<ChecklistResult, "overrideReason">; label: string }[] = [
  { key: "signed", label: "Customer signed" },
  { key: "photos", label: "Photos taken" },
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
  onConfirm: (result: ChecklistResult) => void;
  confirmLabel?: string;
}) {
  const [checks, setChecks] = useState({
    signed: false,
    photos: false,
    equipment: false,
    siteClean: false,
  });
  const [reason, setReason] = useState("");

  const allChecked = Object.values(checks).every(Boolean);
  const needsReason = !allChecked;
  const canConfirm = allChecked || reason.trim().length > 0;

  function toggle(key: keyof typeof checks) {
    setChecks((c) => ({ ...c, [key]: !c[key] }));
  }

  function handleConfirm() {
    if (!canConfirm) return;
    onConfirm({ ...checks, overrideReason: needsReason ? reason.trim() : undefined });
    // reset for next time
    setChecks({ signed: false, photos: false, equipment: false, siteClean: false });
    setReason("");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
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
              <Label htmlFor="override-reason" className="text-red-600">
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
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="h-12 text-base"
          >
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="h-12 text-base"
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
