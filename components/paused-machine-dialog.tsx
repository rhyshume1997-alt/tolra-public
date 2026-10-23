"use client";

/**
 * The paused-machine warning (plan 2.3, R3.1, R3.2): a machine whose last run was paused on another unfinished job. Soft: "I've checked"
 * is always available to workshop, office and admin; the confirmation is recorded against the paused run shown here (the Start or the
 * booking sends back exactly these run ids). For several machines, one dialog lists each paused job. An admin taking over a machine in use
 * gives the reason here too (3 to 500 characters, recorded).
 */
import { useState } from "react";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { type PausedRow, pausedWarningText } from "@/lib/machine-runs";

export function PausedMachineDialog({ open, title, rows, machineName, takeover, busy, onCancel, onConfirm, confirmLabel }: {
  open: boolean;
  title: string;
  rows: PausedRow[];
  machineName: (id: string) => string;
  /** Machines in use by another job that an admin is taking over: a reason is asked for. */
  takeover?: string[];
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (reason: string | null) => void;
  confirmLabel?: string;
}) {
  const [reason, setReason] = useState("");
  const needsReason = Boolean(takeover?.length);
  const names = rows.map((row) => machineName(row.machine_id));
  const label = confirmLabel ?? (rows.length ? `I've checked, use the ${names.length === 1 ? names[0] : "machines"}` : `Take over ${takeover?.join(", ")} and start`);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) { setReason(""); onCancel(); } }}>
      <DialogContent className="max-w-lg" data-testid="paused-machine-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{rows.length ? "Someone paused a job on this machine and it isn't finished yet." : "This machine is in use by another job."}</DialogDescription>
        </DialogHeader>
        {rows.length ? (
          <ul className="space-y-2 text-sm">
            {rows.map((row) => (
              <li key={row.machine_id} data-testid="paused-warning" data-run-id={row.paused_run_id} className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-950 dark:bg-amber-900/20 dark:text-amber-100">
                <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />{pausedWarningText(row, machineName(row.machine_id))}
              </li>
            ))}
          </ul>
        ) : null}
        {needsReason ? (
          <div className="space-y-1 text-sm">
            <p className="font-medium text-red-800 dark:text-red-300">Take over {takeover!.join(", ")}: the other job&apos;s run ends now and the takeover is recorded against both jobs, with your reason.</p>
            <Textarea aria-label="Why are you taking it over?" placeholder="Why are you taking it over? (3 to 500 characters, recorded)" maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
          </div>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => { setReason(""); onCancel(); }}>Cancel</Button>
          <Button variant="start" className="min-h-11" disabled={busy || (needsReason && reason.trim().length < 3)} onClick={() => { const r = needsReason ? reason.trim() : null; setReason(""); onConfirm(r); }}>{label}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
