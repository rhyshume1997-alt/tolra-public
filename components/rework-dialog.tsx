"use client";

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fmtDateTime } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import { type PeopleMap, personName } from "@/lib/people";
import { canReadUsernames, loadCompanyPeople } from "@/lib/company-people";
import { useMaybeUser } from "@/lib/use-user";
import {
  CLOSED_LABELS, REWORK_STATUS_LABELS, type ReworkEntry, type ReworkRecord, type ReworkSummary, finishRework, loadReworkEntries, loadReworkSummary, loadReworks,
  openReplacementRework, quantityText, recordReworkCost, replacementsOwed, scrapQuantity, startRework,
} from "@/lib/rework";
import { supabase } from "@/lib/supabase";

type Props = {
  job: { id: string; job_no: string; quantity_required?: number | string | null } | null;
  /** The signed-in person's role: viewers read, only admin and office see and enter what material cost. */
  role: string | null | undefined;
  onClose: () => void;
  /** Called after any change, so the board can reload its jobs and reworks. */
  onChanged: () => void;
};

const money = (value: number) => `£${value.toFixed(2)}`;

type Act = (work: () => Promise<void>, after?: () => void) => void;

/** One live rework (there is one per failed order line): what failed, and starting, costing, scrapping and finishing it. */
function LiveRework({ live, lineName, entries, entryLine, people, canWrite, canCost, busy, act, setError, quantityOf }: {
  live: ReworkRecord; lineName: string | null; entries: ReworkEntry[]; entryLine: (entry: ReworkEntry) => string; people: PeopleMap;
  canWrite: boolean; canCost: boolean; busy: boolean; act: Act; setError: (message: string | null) => void; quantityOf: number | string | null | undefined;
}) {
  const [hours, setHours] = useState("");
  const [material, setMaterial] = useState("");
  const [materialCost, setMaterialCost] = useState("");
  const [note, setNote] = useState("");
  const [scrapQty, setScrapQty] = useState("");
  const [scrapReason, setScrapReason] = useState("");
  const [finishNote, setFinishNote] = useState("");
  const [remade, setRemade] = useState("");
  const owed = replacementsOwed(live);

  function bookCost() {
    const h = hours.trim() === "" ? null : Number(hours);
    if (h !== null && (!Number.isFinite(h) || h <= 0 || h > 999)) return setError("Hours must be more than 0.");
    if (h === null && !material.trim()) return setError("Enter the hours worked, the material used, or both.");
    const cost = materialCost.trim() === "" ? null : Number(materialCost);
    if (cost !== null && (!Number.isFinite(cost) || cost < 0)) return setError("The material cost must be a sum of money.");
    if (cost !== null && !material.trim()) return setError("Say which material the cost is for.");
    act(() => recordReworkCost({ reworkId: live.id, hours: h, material, materialCost: cost, note }), () => { setHours(""); setMaterial(""); setMaterialCost(""); setNote(""); });
  }

  function scrap() {
    const quantity = Number(scrapQty);
    if (!Number.isInteger(quantity) || quantity < 1) return setError("Enter how many to scrap, as a whole number of 1 or more.");
    if (!scrapReason.trim()) return setError("Give the reason for scrapping.");
    act(async () => { await scrapQuantity({ reworkId: live.id, quantity, reason: scrapReason.trim() }); }, () => { setScrapQty(""); setScrapReason(""); });
  }

  function finish() {
    let count: number | null = null;
    if (owed > 0) {
      count = Number(remade);
      if (remade.trim() === "" || !Number.isInteger(count) || count < 0 || count > owed) return setError(`Enter how many replacements were made for the scrapped parts, from 0 to ${owed}.`);
    }
    act(() => finishRework(live.id, finishNote, count), () => { setFinishNote(""); setRemade(""); });
  }

  return (
    <section aria-label={lineName ? `Current rework: ${lineName}` : "Current rework"} className="space-y-2 rounded-lg border border-red-200 p-3 text-sm">
      <p className="font-semibold text-red-700">{REWORK_STATUS_LABELS[live.status]}{live.follow_up_of ? " · replacements still to make" : ""}</p>
      <dl className="grid gap-1 text-xs">
        {lineName ? <div><dt className="field-label inline">Order line: </dt><dd className="inline">{lineName}</dd></div> : null}
        {live.batch_ref ? <div><dt className="field-label inline">Batch: </dt><dd className="inline">{live.batch_ref}</dd></div> : null}
        <div><dt className="field-label inline">{live.follow_up_of ? "Why: " : "Failed: "}</dt><dd className="inline">{live.reason}</dd></div>
        <div>
          <dt className="field-label inline">{live.follow_up_of ? "To make: " : "Quantity affected: "}</dt>
          <dd className="inline">{live.follow_up_of ? String(live.quantity_affected) : quantityText(live, quantityOf)}{!live.follow_up_of && live.quantity_scrapped ? ` (${live.quantity_scrapped} scrapped)` : ""}</dd>
        </div>
        <div><dt className="field-label inline">Instructions: </dt><dd className="inline">{live.instructions}</dd></div>
        <div><dt className="field-label inline">Assigned to: </dt><dd className="inline">Workshop</dd></div>
        <div><dt className="field-label inline">Raised by: </dt><dd className="inline">{personName(people, live.raised_by)}, {fmtDateTime(live.raised_at)}</dd></div>
        {live.started_at ? <div><dt className="field-label inline">Started by: </dt><dd className="inline">{personName(people, live.started_by)}, {fmtDateTime(live.started_at)}</dd></div> : null}
        {live.finished_at ? <div><dt className="field-label inline">Finished by: </dt><dd className="inline">{personName(people, live.finished_by)}, {fmtDateTime(live.finished_at)}</dd></div> : null}
      </dl>
      {entries.length ? (
        <ul className="divide-y rounded border text-xs" aria-label="Hours, material and scrap">
          {entries.map((entry) => <li key={entry.id} className="p-1.5">{entryLine(entry)}</li>)}
        </ul>
      ) : null}

      {canWrite && live.status === "open" ? (
        <div className="flex justify-end">
          <Button className="bg-brand text-brand-ink hover:bg-brand-hover" disabled={busy} onClick={() => act(() => startRework(live.id))}>Start rework</Button>
        </div>
      ) : null}

      {canWrite && live.status === "in_progress" ? (
        <div className="space-y-3">
          <fieldset className="grid gap-2 rounded-lg border p-2">
            <legend className="px-1 text-xs font-semibold">Hours and material</legend>
            <div className="grid grid-cols-2 gap-2">
              <label className="grid gap-1 text-xs text-slate-500">Hours worked
                <Input name="rework_hours" type="number" inputMode="decimal" min={0} step={0.25} value={hours} onChange={(event) => setHours(event.target.value)} />
              </label>
              <label className="grid gap-1 text-xs text-slate-500">Material used
                <Input name="rework_material" maxLength={500} value={material} onChange={(event) => setMaterial(event.target.value)} placeholder="For example: 1 off EN8 bar" />
              </label>
            </div>
            {canCost ? (
              <label className="grid gap-1 text-xs text-slate-500">Material cost (£)
                <Input name="rework_material_cost" type="number" inputMode="decimal" min={0} step={0.01} value={materialCost} onChange={(event) => setMaterialCost(event.target.value)} />
              </label>
            ) : null}
            <label className="grid gap-1 text-xs text-slate-500">Note (optional)
              <Input name="rework_note" maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
            </label>
            <div className="flex justify-end"><Button variant="outline" disabled={busy} onClick={bookCost}>Add hours / material</Button></div>
          </fieldset>
        </div>
      ) : null}

      {canWrite && !live.follow_up_of && (live.status === "open" || live.status === "in_progress") ? (
        <fieldset className="grid gap-2 rounded-lg border p-2">
          <legend className="px-1 text-xs font-semibold">Scrap</legend>
          <p className="text-xs text-slate-500">Parts that can&apos;t be saved are scrapped with a reason. A replacement then has to be made, so the quantity remaining to make goes up.</p>
          <div className="grid grid-cols-[6rem_1fr] gap-2">
            <label className="grid gap-1 text-xs text-slate-500">Quantity
              <Input name="scrap_quantity" type="number" inputMode="numeric" min={1} step={1} value={scrapQty} onChange={(event) => setScrapQty(event.target.value)} />
            </label>
            <label className="grid gap-1 text-xs text-slate-500">Reason
              <Input name="scrap_reason" maxLength={500} value={scrapReason} onChange={(event) => setScrapReason(event.target.value)} />
            </label>
          </div>
          <div className="flex justify-end"><Button variant="outline" disabled={busy} onClick={scrap}>Scrap quantity</Button></div>
        </fieldset>
      ) : null}

      {canWrite && live.status === "in_progress" ? (
        <div className="grid gap-2">
          {owed > 0 ? (
            <label className="grid gap-1 text-xs text-slate-500">Replacements made for the {owed} scrapped (required: 0 to {owed}; any not made stay held)
              <Input name="replacements_made" type="number" inputMode="numeric" min={0} max={owed} step={1} value={remade} onChange={(event) => setRemade(event.target.value)} />
            </label>
          ) : null}
          <label className="grid gap-1 text-xs text-slate-500">Note on finishing (optional)
            <Input name="finish_note" maxLength={500} value={finishNote} onChange={(event) => setFinishNote(event.target.value)} />
          </label>
          <div className="flex justify-end">
            <Button className="bg-brand text-brand-ink hover:bg-brand-hover" disabled={busy} onClick={finish}>Finish rework: send for re-inspection</Button>
          </div>
        </div>
      ) : null}
      {live.status === "finished" ? <p className="text-xs text-slate-600">The rework is done. Record the inspection again from the Job Board to release it.</p> : null}
    </section>
  );
}

/** A closed rework that still owes replacements: office and admin open a replacement rework for them (made and inspected before release). */
function OwedReplacements({ rework, lineName, busy, act, setError }: { rework: ReworkRecord; lineName: string | null; busy: boolean; act: Act; setError: (message: string | null) => void }) {
  const [instructions, setInstructions] = useState("");
  const owed = replacementsOwed(rework);
  function open() {
    if (!instructions.trim()) return setError("Give the instructions for making the replacements.");
    act(async () => { await openReplacementRework(rework.id, instructions); }, () => setInstructions(""));
  }
  return (
    <fieldset className="grid gap-2 rounded-lg border border-amber-200 p-2" aria-label="Outstanding replacements">
      <legend className="px-1 text-xs font-semibold">{owed} replacement{owed === 1 ? "" : "s"} still to make{lineName ? ` (${lineName})` : ""}</legend>
      <p className="text-xs text-slate-500">They stay held until they are made and pass inspection. Opening a rework for them sends them to the workshop; the rest of the job can still be despatched.</p>
      <label className="grid gap-1 text-xs text-slate-500">Instructions for making them (required)
        <Textarea name="replacement_instructions" rows={2} maxLength={2000} value={instructions} onChange={(event) => setInstructions(event.target.value)} />
      </label>
      <div className="flex justify-end"><Button variant="outline" disabled={busy} onClick={open}>Make the outstanding replacements</Button></div>
    </fieldset>
  );
}

/** A job's rework: what failed (per order line), what the workshop is to do, and the hours, material and scrap booked against it. */
export function ReworkDialog({ job, role, onClose, onChanged }: Props) {
  const [reworks, setReworks] = useState<ReworkRecord[]>([]);
  const [entries, setEntries] = useState<ReworkEntry[]>([]);
  const [summary, setSummary] = useState<ReworkSummary | null>(null);
  const [people, setPeople] = useState<PeopleMap>({});
  const viewer = useMaybeUser();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canWrite = role === "admin" || role === "office" || role === "workshop";
  const canCost = role === "admin" || role === "office";

  const load = useCallback(async (jobId: string) => {
    try {
      // Everything is read first and shown together: the new state (e.g. "Reworked: awaiting re-inspection") must not appear while a
      // later read is still running, because a Close pressed in that gap is ignored while the dialog is busy and it would stay open.
      const rows = await loadReworks(jobId);
      const loadedEntries = await loadReworkEntries(rows.map((row) => row.id));
      const loadedSummary = await loadReworkSummary(jobId);
      const who = supabase ? await loadCompanyPeople(supabase, { usernames: canReadUsernames(viewer?.profile) }) : null;
      setReworks(rows);
      setEntries(loadedEntries);
      setSummary(loadedSummary);
      if (who) setPeople(who);
    } catch (err) {
      setError(friendlyError(err, "Couldn't load the rework."));
    }
  }, []);

  useEffect(() => {
    setReworks([]); setEntries([]); setSummary(null); setError(null);
    if (job) void load(job.id);
  }, [job, load]);

  const act: Act = (work, after) => {
    if (!job || busy) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await work();
        after?.();
        await load(job.id);
        onChanged();
      } catch (err) {
        setError(friendlyError(err, "Couldn't save. Nothing was changed."));
      } finally {
        setBusy(false);
      }
    })();
  };

  const live = reworks.filter((row) => row.status !== "closed").sort((a, b) => a.raised_at.localeCompare(b.raised_at));
  const earlier = reworks.filter((row) => row.status === "closed");
  const owing = earlier.filter((row) => replacementsOwed(row) > 0);
  const entriesOf = (id: string) => entries.filter((entry) => entry.rework_id === id);
  const lineOf = (row: ReworkRecord) => (row.sales_order_line_id ? summary?.lines?.find((line) => line.line_id === row.sales_order_line_id) : undefined);
  const lineName = (row: ReworkRecord) => (row.sales_order_line_id ? lineOf(row)?.description ?? "Order line" : null);
  const manyLines = Boolean(summary?.lines && summary.lines.length > 1);

  function entryLine(entry: ReworkEntry) {
    const who = `${personName(people, entry.created_by)}, ${fmtDateTime(entry.created_at)}`;
    if (entry.kind === "hours") return `${entry.hours} h worked${entry.description ? ` (${entry.description})` : ""} · ${who}`;
    if (entry.kind === "material") return `Material: ${entry.description} · ${who}`;
    if (entry.kind === "remake") return `Replacements made: ${entry.quantity}${entry.description ? ` (${entry.description})` : ""} · ${who}`;
    return `Scrapped ${entry.quantity}: ${entry.description} · ${who}`;
  }

  return (
    <Dialog open={Boolean(job)} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rework: {job?.job_no}</DialogTitle>
          <DialogDescription>A failed inspection sends the part that failed back to the workshop. It is released only by passing the inspection again, or by an admin recording a concession; the rest of the job can be despatched meanwhile.</DialogDescription>
        </DialogHeader>

        {summary ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border p-3 text-xs sm:grid-cols-3" aria-label="Rework totals">
            <div><dt className="field-label">Reworks so far</dt><dd className="font-semibold">{summary.cycles}</dd></div>
            <div><dt className="field-label">Still to rework</dt><dd className="font-semibold">{summary.quantity_in_rework}</dd></div>
            <div><dt className="field-label">Scrapped</dt><dd className="font-semibold">{summary.quantity_scrapped}</dd></div>
            <div><dt className="field-label">Remaining to make</dt><dd className="font-semibold">{summary.remaining_to_make}</dd></div>
            <div><dt className="field-label">Rework hours</dt><dd className="font-semibold">{summary.rework_hours}</dd></div>
            <div><dt className="field-label">Material used</dt><dd className="font-semibold">{summary.material_items} item{summary.material_items === 1 ? "" : "s"}{summary.material_cost !== null ? ` · ${money(summary.material_cost)}` : ""}</dd></div>
            {summary.quantity_available !== undefined && summary.quantity_available !== null && !manyLines ? (
              <div><dt className="field-label">Can be despatched now</dt><dd className="font-semibold">{summary.quantity_available}{summary.quantity_held ? ` (${summary.quantity_held} held)` : ""}</dd></div>
            ) : null}
          </dl>
        ) : null}
        {manyLines ? (
          <table className="w-full rounded-lg border text-xs" aria-label="Held per order line">
            <thead><tr className="text-left text-slate-500"><th className="p-1.5">Order line</th><th className="p-1.5 text-right">Held</th><th className="p-1.5 text-right">To make</th><th className="p-1.5 text-right">Can go</th></tr></thead>
            <tbody>
              {summary!.lines!.map((line) => (
                <tr key={line.line_id} className="border-t">
                  <td className="p-1.5">{line.description}{line.batches ? ` (batch ${line.batches})` : ""}</td>
                  <td className="p-1.5 text-right">{Number(line.held) || ""}</td>
                  <td className="p-1.5 text-right">{Number(line.missing) || ""}</td>
                  <td className="p-1.5 text-right">{line.available}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {summary?.blocked ? <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{summary.blocked}</p> : null}

        {live.length ? live.map((row) => (
          <LiveRework key={row.id} live={row} lineName={lineName(row)} entries={entriesOf(row.id)} entryLine={entryLine} people={people} canWrite={canWrite} canCost={canCost}
            busy={busy} act={act} setError={setError} quantityOf={row.sales_order_line_id ? lineOf(row)?.ordered : job?.quantity_required} />
        )) : reworks.length ? <p className="text-sm text-slate-600">No rework is open on this job.</p> : <p className="text-sm text-slate-600">This job has not failed an inspection.</p>}

        {canCost ? owing.map((row) => <OwedReplacements key={row.id} rework={row} lineName={lineName(row)} busy={busy} act={act} setError={setError} />) : null}
        {!canCost && owing.length ? <p className="text-xs text-slate-600">Replacements are still to make: the office or an admin opens a rework for them.</p> : null}

        {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}

        {earlier.length ? (
          <section aria-label="Earlier reworks" className="space-y-1">
            <h3 className="text-xs font-semibold text-slate-600">Earlier reworks</h3>
            <ul className="divide-y rounded-lg border text-xs">
              {earlier.map((row) => (
                <li key={row.id} className="space-y-0.5 p-2">
                  <p className="font-medium">
                    {row.closed_how ? CLOSED_LABELS[row.closed_how] : REWORK_STATUS_LABELS[row.status]}{" "}
                    <span className="font-normal text-slate-500">· {lineName(row) ? `${lineName(row)}: ` : ""}{row.follow_up_of ? `${row.quantity_affected} replacements` : quantityText(row, lineOf(row)?.ordered ?? job?.quantity_required)}{row.batch_ref ? ` · batch ${row.batch_ref}` : ""} · raised {fmtDateTime(row.raised_at)}</span>
                  </p>
                  <p className="text-slate-600">{row.reason}</p>
                  {entriesOf(row.id).map((entry) => <p key={entry.id} className="text-slate-500">{entryLine(entry)}</p>)}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="flex justify-end">
          <Button variant="outline" disabled={busy} onClick={onClose}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
