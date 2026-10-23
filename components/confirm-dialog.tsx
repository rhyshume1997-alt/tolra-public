"use client";

import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * "Are you sure?" step in the same dialog pattern as the other confirmations (issue invoice, discard worksheet):
 * a title that names the target, a plain description, Cancel and a clearly named confirm button.
 */
export function ConfirmDialog({ open, title, description, confirmLabel, cancelLabel = "Cancel", destructive = false, busy = false, confirmDisabled = false, onConfirm, onCancel, children }: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild><div>{description}</div></DialogDescription>
        </DialogHeader>
        {children}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>{cancelLabel}</Button>
          <Button variant={destructive ? "destructive" : "default"} className={destructive ? "" : "bg-brand text-brand-ink hover:bg-brand-hover"} disabled={busy || confirmDisabled} onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
