"use client";

import { useRef, useState } from "react";
import { Camera, Fuel, PackageOpen, ClipboardList, Wrench, KeyRound, MessageSquareWarning, X } from "lucide-react";
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
import { downscaleImage, uploadPhotos } from "@/lib/media/photo";
import type { CloseoutResult } from "@/lib/types";

// The mandatory Driver Route Closeout. Fired on "Arrived at Warehouse": the driver walks each
// item, anything unconfirmed needs a reason (flagged to the office), and a final "anything to
// report?" question can capture an issue with a note + optional photo. It is a control, not a
// blind click-through — but per the exception-handling rule the driver can still submit with a
// reason so a truck is never stuck outside the app.
type CloKey = Exclude<keyof CloseoutResult, "overrideReason" | "hasIssue" | "issueNote">;

const ITEMS: { key: CloKey; label: string; hint: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "refueled", label: "Refueled the truck", hint: "Fuel meets the end-of-day requirement. If it's low, refuel before parking.", icon: Fuel },
  { key: "itemsUnloaded", label: "Returned rentals unloaded", hint: "Tables, chairs, linens, tent gear, dance floors etc. put back in their warehouse spots.", icon: PackageOpen },
  { key: "discrepanciesReported", label: "Discrepancies reported", hint: "Any missing, damaged, or unreturned items reported to dispatch — nothing left unreported.", icon: ClipboardList },
  { key: "damageInspected", label: "Truck inspected for damage", hint: "Exterior, tires, mirrors, cargo area. Report any new damage, warning lights, or mechanical issue.", icon: Wrench },
  { key: "securedKeysReturned", label: "Truck secured & keys returned", hint: "Parked in its space, windows up, doors locked, keys returned to the designated spot.", icon: KeyRound },
  { key: "notesSubmitted", label: "Route notes submitted", hint: "All stops accounted for. Access problems, delays, incomplete pickups etc. sent to dispatch.", icon: MessageSquareWarning },
];

const EMPTY: Record<CloKey, boolean> = {
  refueled: false,
  itemsUnloaded: false,
  discrepanciesReported: false,
  damageInspected: false,
  securedKeysReturned: false,
  notesSubmitted: false,
};

export function ReturnChecklistDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (result: CloseoutResult, photoIds?: string[]) => void;
}) {
  const [checks, setChecks] = useState<Record<CloKey, boolean>>(EMPTY);
  const [reason, setReason] = useState("");
  const [hasIssue, setHasIssue] = useState<boolean | null>(null);
  const [issueNote, setIssueNote] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const allChecked = ITEMS.every((i) => checks[i.key]);
  const needsReason = !allChecked;
  const canConfirm =
    !saving &&
    hasIssue !== null && // must answer the final question
    (allChecked || reason.trim().length > 0) && // any unchecked item → reason
    (!hasIssue || issueNote.trim().length > 0); // reported an issue → note

  function toggle(key: CloKey) {
    setChecks((c) => ({ ...c, [key]: !c[key] }));
  }

  async function addPhotos(files: FileList | null) {
    if (!files?.length) return;
    const added = await Promise.all(Array.from(files).map(downscaleImage));
    setPhotos((p) => [...p, ...added.filter(Boolean)]);
    if (fileRef.current) fileRef.current.value = "";
  }

  function reset() {
    setChecks(EMPTY);
    setReason("");
    setHasIssue(null);
    setIssueNote("");
    setPhotos([]);
    setError(null);
  }

  async function handleConfirm() {
    if (!canConfirm) return;
    setError(null);
    let photoIds: string[] | undefined;
    if (hasIssue && photos.length > 0) {
      setSaving(true);
      const ids = await uploadPhotos(photos);
      setSaving(false);
      if (!ids) {
        setError("Couldn't save the photo — check signal and try again.");
        return;
      }
      photoIds = ids;
    }
    onConfirm(
      {
        refueled: checks.refueled,
        itemsUnloaded: checks.itemsUnloaded,
        discrepanciesReported: checks.discrepanciesReported,
        damageInspected: checks.damageInspected,
        securedKeysReturned: checks.securedKeysReturned,
        notesSubmitted: checks.notesSubmitted,
        overrideReason: needsReason ? reason.trim() : undefined,
        hasIssue: Boolean(hasIssue),
        issueNote: hasIssue ? issueNote.trim() : undefined,
      },
      photoIds,
    );
    reset();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Route closeout</DialogTitle>
          <DialogDescription>
            Confirm each item before closing the route. Anything you can&apos;t confirm needs a
            reason and is flagged to the office.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {ITEMS.map((item) => {
            const Icon = item.icon;
            const on = checks[item.key];
            return (
              <label
                key={item.key}
                className={`flex items-start gap-3 rounded-lg border p-4 text-left transition-colors active:bg-accent ${
                  on ? "border-primary/40 bg-primary/[0.06]" : "border-white/10"
                }`}
              >
                <Checkbox checked={on} onCheckedChange={() => toggle(item.key)} className="mt-0.5 size-6" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-lg font-medium">
                    <Icon className="size-5 shrink-0 text-primary" />
                    {item.label}
                  </span>
                  <span className="mt-0.5 block text-sm text-muted-foreground">{item.hint}</span>
                </span>
              </label>
            );
          })}

          {needsReason && (
            <div className="space-y-2 rounded-lg border border-amber-400/30 bg-amber-400/[0.06] p-3">
              <Label htmlFor="closeout-reason" className="text-foreground">
                What couldn&apos;t you confirm? (required — sent to the office)
              </Label>
              <Textarea
                id="closeout-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Couldn't refuel — station closed. Truck at 1/4 tank."
                rows={2}
              />
            </div>
          )}

          {/* Final question — anything dispatch/management should know about. */}
          <div className="space-y-3 rounded-lg border border-white/10 p-4">
            <span className="text-lg font-medium">
              Did anything happen today dispatch or management needs to know about?
            </span>
            <div className="grid grid-cols-2 gap-3">
              <Button
                type="button"
                variant={hasIssue === false ? "default" : "secondary"}
                onClick={() => setHasIssue(false)}
                className="h-12 text-base"
              >
                No issues
              </Button>
              <Button
                type="button"
                variant={hasIssue === true ? "default" : "secondary"}
                onClick={() => setHasIssue(true)}
                className="h-12 text-base"
              >
                Yes — report
              </Button>
            </div>

            {hasIssue && (
              <div className="space-y-3 pt-1">
                <Textarea
                  value={issueNote}
                  onChange={(e) => setIssueNote(e.target.value)}
                  placeholder="What happened? (required)"
                  rows={2}
                />
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-muted-foreground">
                    Add a photo{photos.length ? ` (${photos.length})` : " (optional)"}
                  </span>
                  <Button type="button" variant="outline" onClick={() => fileRef.current?.click()} className="h-11 gap-2">
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
                  <div className="flex flex-wrap gap-2">
                    {photos.map((src, i) => (
                      <div key={i} className="relative">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={src} alt={`issue ${i + 1}`} className="size-16 rounded-md object-cover" />
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
            )}
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="h-12 text-base" disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!canConfirm} className="h-12 text-base">
            {saving ? "Saving…" : "Close route"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
