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
import { Textarea } from "@/components/ui/textarea";

const PRESETS = [
  "Running late",
  "Stuck in traffic",
  "Need help at this stop",
  "Can't reach customer",
  "Access / gate issue",
  "Truck issue",
];

/** Driver → dispatch note that fans out to Slack (not something GSPRO does). */
export function DispatchDialog({
  open,
  onOpenChange,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSend: (message: string) => void;
}) {
  const [message, setMessage] = useState("");

  function send(text: string) {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setMessage("");
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Message dispatch</DialogTitle>
          <DialogDescription>
            Sends a note to the dispatch team on Slack.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-2">
            {PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => send(p)}
                className="surface rounded-xl border border-white/5 px-3 py-3 text-sm font-medium transition-colors hover:border-primary/40 active:scale-[0.97]"
              >
                {p}
              </button>
            ))}
          </div>

          <div className="space-y-2">
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Or type a custom message…"
              rows={2}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="h-12"
          >
            Cancel
          </Button>
          <Button
            onClick={() => send(message)}
            disabled={message.trim().length === 0}
            className="h-12"
          >
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
