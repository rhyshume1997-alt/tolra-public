"use client";

import { Archive, ArchiveRestore } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { ManualState, Phase, PhaseFilterValue } from "@/lib/archive";
import { friendlyError } from "@/lib/friendly-error";

const LABELS: Record<PhaseFilterValue, string> = { open: "Open", done: "Done", archived: "Archived", all: "All" };

/** Open / Done / Archived / All with counts (lib/archive). */
export function PhaseFilter({ value, onChange, counts, labels = {}, note, phases = ["open", "done", "archived", "all"] }: {
  value: PhaseFilterValue;
  onChange: (value: PhaseFilterValue) => void;
  counts: Record<Phase, number>;
  labels?: Partial<Record<PhaseFilterValue, string>>;
  /** The buttons shown (default all four; customers have no Done). */
  phases?: ReadonlyArray<PhaseFilterValue>;
  /** A short line saying what the counts count, shown beside the buttons (and on hover). */
  note?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Show" title={note}>
      <span className="text-[0.8125rem] font-semibold text-slate-600">Show</span>
      {phases.map((phase) => (
        <Button key={phase} size="sm" variant={value === phase ? "default" : "outline"} aria-pressed={value === phase} className={value === phase ? "bg-brand text-brand-ink" : ""} onClick={() => onChange(phase)}>
          {labels[phase] ?? LABELS[phase]}{phase === "all" ? "" : ` (${counts[phase]})`}
        </Button>
      ))}
      {note ? <span className="text-xs text-slate-500">{note}</span> : null}
    </div>
  );
}

/**
 * Archive / Unarchive for one record (admin and office). Archived records stay viewable and printable.
 * The text button has no icon on purpose: an icon first in the button shifts its baseline, so beside the plain-text
 * View / Edit buttons in a table cell it sat higher than they did. The icon-only size keeps its icon.
 */
export function ArchiveButton({ id, phase, manual, onSet, size = "sm" }: {
  id: string | undefined;
  phase: Phase;
  manual: ManualState | undefined;
  onSet: (id: string, state: ManualState | "auto") => Promise<void>;
  size?: "default" | "sm" | "icon";
}) {
  if (!id) return null;
  const archived = phase === "archived";
  const run = async () => {
    try {
      // Unarchiving a record the age rule archived keeps it active; one archived by hand goes back to the rule.
      await onSet(id, archived ? (manual === "archived" ? "auto" : "active") : "archived");
      toast.success(archived ? "Moved out of the archive" : "Archived (nothing is deleted: see Show > Archived)");
    } catch (err) {
      toast.error(friendlyError(err, "Couldn't change the archive state."));
    }
  };
  const Icon = archived ? ArchiveRestore : Archive;
  return size === "icon"
    ? <Button size="icon" variant="outline" className="size-8" title={archived ? "Unarchive" : "Archive"} aria-label={archived ? "Unarchive" : "Archive"} onClick={() => void run()}><Icon className="size-4" /></Button>
    : <Button size={size} variant="outline" onClick={() => void run()}>{archived ? "Unarchive" : "Archive"}</Button>;
}
