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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ExceptionType } from "@/lib/types";

const TYPES: ExceptionType[] = [
  "Customer unavailable",
  "Wrong address",
  "Access denied",
  "Vehicle issue",
  "Missing inventory",
  "Damaged inventory",
  "Route issue",
  "Automation failure",
  "Other",
];

export function ExceptionDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (type: ExceptionType, reason: string) => void;
}) {
  const [type, setType] = useState<ExceptionType | "">("");
  const [reason, setReason] = useState("");

  const canSubmit = type !== "" && reason.trim().length > 0;

  function handleSubmit() {
    if (!canSubmit) return;
    onSubmit(type as ExceptionType, reason.trim());
    setType("");
    setReason("");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Report an exception</DialogTitle>
          <DialogDescription>
            This alerts dispatch on Slack and records an audit entry.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as ExceptionType)}>
              <SelectTrigger className="h-12 text-base">
                <SelectValue placeholder="Select a type" />
              </SelectTrigger>
              <SelectContent>
                {TYPES.map((t) => (
                  <SelectItem key={t} value={t} className="text-base">
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="exception-reason">Details</Label>
            <Textarea
              id="exception-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="What happened?"
              rows={3}
            />
          </div>
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
            variant="destructive"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="h-12 text-base"
          >
            Submit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
