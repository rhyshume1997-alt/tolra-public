"use client";

/**
 * The Job Board's Machine column picker (plan 2.2, R2.4): the machines Play starts the job on, ticked before Play. A popover on a desk, a
 * bottom sheet on a phone. "No machine (bench)" is its own deliberate choice, never the default. A machine another job holds shows who has
 * it ("In use: J-120, Dave since 09:12"): workshop and office can't tick it; an admin can (Play then asks for the takeover reason). A
 * machine whose last run was paused on another unfinished job shows "Paused: J-118, Dave 12:05" and can be ticked (Play then warns).
 * Nothing is written until Play (or Add, while the job runs). On a phone the sheet hides the card's Play, so it carries its own Start (the same
 * Play, on what is ticked; a machine or the bench must be ticked first, never a guessed default): pick, Start, with no separate Done.
 */
import { useState } from "react";
import Link from "next/link";
import { Popover } from "radix-ui";
import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { type MachinePick, pickIsChosen } from "@/lib/job-actions";
import { type InUseRow, type PausedRow, pausedChoiceText } from "@/lib/machine-runs";
import { pickerSummaryText } from "@/lib/job-machine-plan";
import { pickerEmptyReason } from "@/lib/machine-picker-empty";
import { fmtDateTime } from "@/lib/dates";
import { cn } from "@/lib/utils";

export type PickerMachine = { id: string; name: string; planned: boolean; booked: boolean };

export function MachinePicker({ jobNo, jobId, machines, inUse, paused, pick, onChange, role, disabled, running, sheet, onAdd, onStart, touch, active = true, open: openProp, onOpenChange, stage, loadFailed = false, loading = false, canAddMachine = false }: {
  jobNo: string;
  jobId: string;
  machines: PickerMachine[];
  inUse: Map<string, InUseRow>;
  paused: Map<string, PausedRow>;
  pick: MachinePick;
  onChange: (pick: MachinePick) => void;
  role: string | null | undefined;
  disabled?: boolean;
  /** The job runs now: the picker adds machines ("Add") instead of choosing what Play starts on. */
  running?: boolean;
  /** Phone: a bottom sheet instead of a popover. */
  sheet?: boolean;
  onAdd?: (machineIds: string[]) => void;
  /** Phone sheet: Start on what is ticked (the board's Play with this pick). Offered only when something (a machine or the bench) is ticked. */
  onStart?: (pick: MachinePick) => void;
  touch?: string;
  /** This copy is the one on screen (the board renders a phone and a desk layout; only one opens). */
  active?: boolean;
  /** Controlled open state (the board opens the picker when Play has nothing to start on). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The stage Play moves the job to (only offered while it is at Material or Setup; lib/job-actions stageAfterStart). */
  stage?: { value: "setup" | "machining"; fromSetup: boolean; onChange: (stage: "setup" | "machining") => void } | null;
  /** The company's machine list could not be read: an empty picker says so rather than "No machines set up yet". */
  loadFailed?: boolean;
  /** The company's machine list is still being read: an empty picker says "Loading machines…", not "No machines set up yet". */
  loading?: boolean;
  /** The person may add a machine and the Machine Schedule page is open to them (admin or office, section on): the empty notice links there. */
  canAddMachine?: boolean;
}) {
  const [openState, setOpenState] = useState(false);
  const open = (openProp ?? openState) && active;
  const setOpen = (next: boolean) => { setOpenState(next); onOpenChange?.(next); };
  const [adding, setAdding] = useState<Set<string>>(new Set());
  const isAdmin = role === "admin";
  // Nothing can be ticked: say why (and where machines are added) instead of an inert list.
  const empty = pickerEmptyReason(machines, inUse, role, jobId, loadFailed, { running, canAdd: canAddMachine, loading });
  const summary = pickerSummaryText({ running: !!running, pick, machines });

  const toggle = (id: string) => {
    if (running) {
      const next = new Set(adding);
      if (next.has(id)) next.delete(id); else next.add(id);
      setAdding(next);
      return;
    }
    const set = new Set(pick.machines);
    if (set.has(id)) set.delete(id); else set.add(id);
    onChange({ machines: machines.filter((m) => set.has(m.id)).map((m) => m.id), bench: false });
  };
  const chooseBench = () => onChange(pick.bench ? { machines: [], bench: false } : { machines: [], bench: true });

  const list = (
    <div className="space-y-1" data-testid="machine-picker" data-job-id={jobId}>
      {empty ? (
        <div data-testid="picker-empty" data-reason={empty.code} role="status" className="space-y-1 rounded-md border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-700 dark:border-slate-600 dark:text-slate-200">
          <p>{empty.reason}</p>
          {empty.next === "link" ? <p><Link href="/schedule#machines" data-testid="picker-add-machine-link" className="font-semibold text-brand underline">Add a machine on the Machine Schedule</Link></p> : null}
          {empty.next === "ask" ? <p className="text-xs text-slate-600 dark:text-slate-300">Ask an admin or office to add a machine.</p> : null}
        </div>
      ) : null}
      {running && empty ? null : <ul className="max-h-72 space-y-1 overflow-y-auto" aria-label={`Machines for ${jobNo}`}>
        {machines.map((machine) => {
          const live = inUse.get(machine.id);
          const taken = Boolean(live && live.job_id !== jobId);
          const mine = Boolean(live && live.job_id === jobId);
          const pausedRow = paused.get(machine.id);
          const pausedOther = pausedRow && pausedRow.job_id !== jobId ? pausedRow : null;
          const checked = running ? adding.has(machine.id) : pick.machines.includes(machine.id);
          const blocked = disabled || mine || (taken && !isAdmin);
          return (
            <li key={machine.id} data-testid="picker-machine" data-machine={machine.name} data-taken={taken ? "true" : undefined} data-paused={pausedOther ? "true" : undefined}>
              <label className={cn("flex items-start gap-3 rounded-md border px-3 py-2 text-sm", touch, checked ? "border-brand bg-amber-50 dark:bg-amber-900/20" : "border-slate-200 dark:border-slate-700", blocked ? "cursor-not-allowed opacity-70" : "cursor-pointer")}>
                <input type="checkbox" className="mt-0.5 size-5 shrink-0 accent-[var(--brand)]" aria-label={`${running ? "Add" : "Start on"} ${machine.name}`} checked={checked || mine} disabled={blocked} onChange={() => toggle(machine.id)} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2 font-semibold">{machine.name}
                    {machine.planned ? <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">{machine.booked ? "Booked" : "Planned"}</span> : null}
                    {mine ? <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-800">Running this job</span> : null}
                  </span>
                  {taken && live ? <span data-testid="picker-in-use" className="block text-xs font-medium text-red-700 dark:text-red-400">In use: {live.job_no}, {live.operator_name ?? "—"} since {fmtDateTime(live.started_at)}{isAdmin ? " (admin: take over with a reason)" : ""}</span> : null}
                  {!taken && pausedOther ? <span data-testid="picker-paused" className="block text-xs font-medium text-amber-800 dark:text-amber-300">{pausedChoiceText(pausedOther)} (check with them first)</span> : null}
                </span>
              </label>
            </li>
          );
        })}
      </ul>}
      {running && empty ? null : running ? (
        <Button size="sm" variant="start" className={cn("w-full", touch)} disabled={disabled || adding.size === 0} onClick={() => { onAdd?.([...adding]); setAdding(new Set()); setOpen(false); }}>
          {`Add ${adding.size || ""} machine${adding.size === 1 ? "" : "s"}`.replace("  ", " ")}
        </Button>
      ) : (
        <label className={cn("flex items-center gap-3 rounded-md border px-3 py-2 text-sm", touch, pick.bench ? "border-brand bg-amber-50 dark:bg-amber-900/20" : "border-dashed border-slate-300 dark:border-slate-600", disabled ? "opacity-70" : "cursor-pointer")}>
          <input type="checkbox" className="size-5 shrink-0 accent-[var(--brand)]" aria-label="No machine (bench)" checked={pick.bench} disabled={disabled} onChange={chooseBench} />
          <span><span className="font-semibold">No machine (bench)</span><span className="block text-xs text-slate-500">Bench or outsourced work: the job is timed without a machine.</span></span>
        </label>
      )}
      {!running && stage ? (
        <label className="flex flex-wrap items-center gap-2 pt-1 text-sm">Play moves the job to
          <select aria-label="Stage after starting" className={cn("rounded-md border bg-background px-2 py-1 text-sm", touch)} value={stage.value} disabled={disabled} onChange={(event) => stage.onChange(event.target.value as "setup" | "machining")}>
            <option value="machining">Machining</option>
            {stage.fromSetup ? null : <option value="setup">Setup</option>}
          </select>
        </label>
      ) : null}
    </div>
  );

  const trigger = (
    <Button type="button" size="sm" variant="outline" className={cn("max-w-full justify-between gap-1 normal-case tracking-normal", touch)} disabled={disabled} aria-label={running ? `Add a machine to ${jobNo}${empty ? `, none can be added: ${empty.reason}` : ""}` : `Choose where ${jobNo} runs: ${summary}`} aria-haspopup="dialog" aria-expanded={open} onClick={sheet ? () => setOpen(true) : undefined}>
      <span className="truncate font-sans text-xs">{summary}</span><ChevronDown className="size-3.5 shrink-0" />
    </Button>
  );

  const picked = pickIsChosen(pick);
  // Starting: Start (nothing is written until it is pressed; disabled until a machine or the bench is ticked). Adding while running has its own Add.
  const sheetAction = !running && onStart
    ? <Button variant="start" className={cn("mt-2 w-full", touch)} disabled={disabled || !picked} onClick={() => { setOpen(false); onStart(pick); }}>Start</Button>
    : running ? null : <Button variant="outline" className={cn("mt-2 w-full", touch)} onClick={() => setOpen(false)}>Done</Button>;
  if (sheet) {
    return (
      <>
        {trigger}
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto">
            <SheetHeader>
              <SheetTitle>{running ? `Add a machine to ${jobNo}` : `${jobNo}: which machine?`}</SheetTitle>
              <SheetDescription>{running ? "Tick the machine(s) to add, then Add." : "Tick the machine(s) to start on, or No machine (bench), then Start."}</SheetDescription>
            </SheetHeader>
            <div className="px-4 pb-4">{list}{sheetAction}</div>
          </SheetContent>
        </Sheet>
      </>
    );
  }
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={4} className="z-50 w-80 rounded-lg border border-line bg-surface p-3 shadow-lg" aria-label={`Machines for ${jobNo}`}>
          {list}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
