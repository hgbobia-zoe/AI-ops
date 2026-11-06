"use client";

// In-app confirm dialog: a drop-in replacement for window.confirm that renders inside the app (the browser's
// own "site says" popup looks foreign and can't be styled). Usage:
//
//   const [confirm, confirmDialog] = useConfirm();
//   if (!(await confirm({ title: "Approve?", body: "…", confirmLabel: "Approve" }))) return;
//   …
//   return <>{button}{confirmDialog}</>;

import * as React from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface ConfirmOptions {
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "destructive";
}

export function useConfirm(): [(o: ConfirmOptions) => Promise<boolean>, React.ReactNode] {
  const [opts, setOpts] = React.useState<ConfirmOptions | null>(null);
  const resolver = React.useRef<((ok: boolean) => void) | null>(null);

  const confirm = React.useCallback((o: ConfirmOptions) => {
    resolver.current?.(false); // a second ask cancels any pending one
    setOpts(o);
    return new Promise<boolean>((resolve) => { resolver.current = resolve; });
  }, []);

  const settle = (ok: boolean): void => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpts(null);
  };

  const node = (
    <Dialog open={opts != null} onOpenChange={(open) => { if (!open) settle(false); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{opts?.title}</DialogTitle>
          {opts?.body != null && <DialogDescription render={<div />} className="space-y-2 text-[13px] leading-relaxed">{opts.body}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => settle(false)}>{opts?.cancelLabel ?? "Cancel"}</Button>
          <Button variant={opts?.tone === "destructive" ? "destructive" : "default"} onClick={() => settle(true)}>{opts?.confirmLabel ?? "Confirm"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return [confirm, node];
}
