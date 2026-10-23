"use client";

/**
 * The machines a sales order's lines will run on, with the hours (migration 043). Admin and office set them per line while the order
 * is open; the order's lines are made here if they don't exist yet (ensure_sales_order_lines: the quote's lines, or one line for the
 * order). When the order converts, the plan is summed per machine on the job and edited there; this dialog then shows it read-only,
 * "as ordered".
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { friendlyError } from "@/lib/friendly-error";
import { MAX_MACHINES, MAX_MACHINE_HOURS, type OrderPlanRow, describeMachines, formatHours, groupPlanByLine, sumMachineHours } from "@/lib/so-machines";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

export type SoMachinesOrder = { id: string; ref: string; converted: boolean };
type Line = { id: string; position: number; description: string; quantity: number };
type Row = { key: number; machineId: string; hours: string };
type MachineChoice = { id: string; name: string; active: boolean };

export function SoMachinesDialog({ order, onClose, onSaved }: { order: SoMachinesOrder | null; onClose: () => void; onSaved: () => void }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [rows, setRows] = useState<Record<string, Row[]>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [detached, setDetached] = useState<OrderPlanRow[]>([]);
  const [machines, setMachines] = useState<MachineChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const readOnly = Boolean(order?.converted);

  useEffect(() => {
    if (!order || !supabase) return;
    let active = true;
    setLoading(true); setLoadError(null); setLines([]); setRows({}); setSaved({}); setDetached([]);
    (async () => {
      // An open order gets its lines now (idempotent); a converted order's lines are what they were.
      if (!order.converted) {
        const ensured = await supabase!.rpc("ensure_sales_order_lines", { p_order: order.id });
        if (ensured.error) throw ensured.error;
      }
      const [lineRes, planRes, machineRes] = await Promise.all([
        supabase!.from("sales_order_lines").select("id, position, description, quantity").eq("sales_order_id", order.id).order("position"),
        supabase!.from("sales_order_line_machines").select("machine_id, estimated_hours, line_key, sales_order_line_id, position").eq("sales_order_id", order.id),
        supabase!.from("machines").select("id, name, active").order("name"),
      ]);
      if (lineRes.error) throw lineRes.error;
      if (planRes.error) throw planRes.error;
      if (machineRes.error) throw machineRes.error;
      if (!active) return;
      const lineRows = (lineRes.data ?? []).map((l) => ({ id: String(l.id), position: Number(l.position), description: String(l.description), quantity: Number(l.quantity) }));
      const plan = (planRes.data ?? []).map((r): OrderPlanRow => ({ machine_id: String(r.machine_id), estimated_hours: Number(r.estimated_hours), line_key: Number(r.line_key), sales_order_line_id: r.sales_order_line_id ? String(r.sales_order_line_id) : null, position: Number(r.position) }));
      const grouped = groupPlanByLine(lineRows, plan);
      const next: Record<string, Row[]> = {};
      const snapshot: Record<string, string> = {};
      for (const line of lineRows) {
        next[line.id] = (grouped.byLine.get(line.id) ?? []).map((r, i) => ({ key: i + 1, machineId: r.machine_id, hours: String(r.estimated_hours) }));
        snapshot[line.id] = fingerprint(next[line.id]);
      }
      setLines(lineRows); setRows(next); setSaved(snapshot); setDetached(grouped.detached);
      setMachines((machineRes.data ?? []).map((m) => ({ id: String(m.id), name: String(m.name), active: m.active !== false })));
    })().catch((error) => { if (active) setLoadError(friendlyError(error, "Couldn't load the order's lines.")); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [order]);

  const nameOf = useMemo(() => new Map(machines.map((m) => [m.id, m.name])), [machines]);
  const live = useMemo(() => machines.filter((m) => m.active), [machines]);
  const allRows = Object.values(rows).flat();
  const changed = lines.filter((line) => fingerprint(rows[line.id] ?? []) !== saved[line.id]);
  const onJob = sumMachineHours([
    ...lines.flatMap((line) => (rows[line.id] ?? []).filter((r) => r.machineId).map((r, i): OrderPlanRow => ({ machine_id: r.machineId, estimated_hours: Number(r.hours) || 0, line_key: line.position, sales_order_line_id: line.id, position: i }))),
  ]);
  // One job_machines row holds at most 1000 h: the function refuses more across the lines, so say so before saving.
  const overHours = onJob.filter((m) => m.hours > MAX_MACHINE_HOURS);
  const badRow = allRows.some((row) => !row.machineId || row.hours === "" || !(Number(row.hours) >= 0 && Number(row.hours) <= MAX_MACHINE_HOURS)) || overHours.length > 0;

  const setRow = (lineId: string, key: number, patch: Partial<Row>) => setRows((current) => ({ ...current, [lineId]: (current[lineId] ?? []).map((row) => (row.key === key ? { ...row, ...patch } : row)) }));
  const addRow = (lineId: string) => setRows((current) => {
    const used = new Set((current[lineId] ?? []).map((r) => r.machineId));
    const free = live.find((m) => !used.has(m.id));
    return { ...current, [lineId]: [...(current[lineId] ?? []), { key: Date.now() + (current[lineId]?.length ?? 0), machineId: free?.id ?? "", hours: "" }] };
  });
  const removeRow = (lineId: string, key: number) => setRows((current) => ({ ...current, [lineId]: (current[lineId] ?? []).filter((row) => row.key !== key) }));

  async function save() {
    if (!order || !supabase || readOnly || badRow || saving) return;
    setSaving(true);
    try {
      for (const line of changed) {
        const { error } = await supabase.rpc("set_sales_order_line_machines", {
          p_order: order.id, p_line: line.id,
          p_machines: (rows[line.id] ?? []).map((row) => ({ machine_id: row.machineId, hours: Number(row.hours) })),
        });
        if (error) throw error;
        setSaved((current) => ({ ...current, [line.id]: fingerprint(rows[line.id] ?? []) }));
      }
      toast.success(`Machines saved on ${order.ref}`);
      onSaved();
      onClose();
    } catch (error) {
      if ((error as { hint?: string })?.hint === "order_converted") toast.error("This order has been converted to a job: change the machines on the job.");
      else toast.error(friendlyError(error, "Couldn't save the machines."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={Boolean(order)} onOpenChange={(next) => !next && !saving && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Machines - {order?.ref}</DialogTitle>
          <DialogDescription>
            {readOnly
              ? "As ordered. This order has been converted: the job holds the plan now, and it is changed on the Job Board."
              : "The machine(s) each line will run on and the hours it needs. When the order converts, they carry to the job (summed per machine) and stay editable there. Nothing is booked on the schedule until you book it from the job."}
          </DialogDescription>
        </DialogHeader>
        {loadError ? <p role="alert" className="text-sm text-red-700">{loadError}</p> : null}
        {loading ? <p className="text-sm text-slate-500" role="status">Loading the order&apos;s lines...</p> : null}
        <div className="space-y-4" data-testid="so-machines">
          {lines.map((line, lineIndex) => {
            const lineRows = rows[line.id] ?? [];
            const used = new Set(lineRows.map((r) => r.machineId));
            return (
              <fieldset key={line.id} data-testid="so-machines-line" className="space-y-2 rounded-md border p-3">
                <legend className="px-1 text-sm font-medium">Line {lineIndex + 1}: {line.description}{line.quantity !== 1 ? ` x ${line.quantity}` : ""}</legend>
                {lineRows.length === 0 ? <p className="text-xs text-slate-500">No machine yet.</p> : null}
                {lineRows.map((row, index) => (
                  <div key={row.key} className="grid gap-2 sm:grid-cols-[1fr_7rem_auto] sm:items-end">
                    <label className="space-y-1 text-xs">Machine {index + 1}
                      <select aria-label={`Line ${lineIndex + 1} machine ${index + 1}`} disabled={readOnly} className="min-h-11 w-full rounded-md border bg-background px-3 text-sm" value={row.machineId} onChange={(e) => setRow(line.id, row.key, { machineId: e.target.value })}>
                        <option value="">Choose a machine</option>
                        {machines.filter((m) => m.id === row.machineId || (m.active && !used.has(m.id))).map((m) => <option key={m.id} value={m.id}>{m.name}{m.active ? "" : " (inactive)"}</option>)}
                      </select>
                    </label>
                    <label className="space-y-1 text-xs">Hours
                      <Input aria-label={`Line ${lineIndex + 1} hours on machine ${index + 1}`} disabled={readOnly} type="number" min={0} max={MAX_MACHINE_HOURS} step="0.25" className="min-h-11" value={row.hours} onChange={(e) => setRow(line.id, row.key, { hours: e.target.value })} />
                    </label>
                    {readOnly ? <span /> : <Button type="button" variant="outline" className="min-h-11" aria-label={`Remove line ${lineIndex + 1} machine ${index + 1}`} onClick={() => removeRow(line.id, row.key)}><Trash2 className="size-4" /></Button>}
                  </div>
                ))}
                {readOnly ? null : <Button type="button" variant="outline" className="min-h-11" disabled={lineRows.length >= MAX_MACHINES || lineRows.length >= live.length} onClick={() => addRow(line.id)}><Plus className="size-4" /> Add machine</Button>}
              </fieldset>
            );
          })}
          {detached.length ? (
            <p data-testid="so-machines-detached" className="text-xs text-slate-500">
              From before the order&apos;s lines changed, no longer on any line (removed when you save, not carried): {describeMachines(detached.map((r) => ({ name: nameOf.get(r.machine_id) ?? "Machine", hours: r.estimated_hours })))}.
            </p>
          ) : null}
          {!loading && lines.length ? (
            <p data-testid="so-machines-summary" className={cn("text-sm", onJob.length ? "text-ink" : "text-slate-500")}>
              <strong>On the job:</strong> {onJob.length ? `${describeMachines(onJob.map((m) => ({ name: nameOf.get(m.machine_id) ?? "Machine", hours: m.hours })))} (${formatHours(onJob.reduce((s, m) => s + m.hours, 0))} in all)` : "no machines"}
            </p>
          ) : null}
          {overHours.length ? (
            <p role="alert" className="text-sm text-red-700">A machine can carry at most 1000 hours across the order&apos;s lines: {describeMachines(overHours.map((m) => ({ name: nameOf.get(m.machine_id) ?? "Machine", hours: m.hours })))}. Lower the hours.</p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" className="min-h-11" disabled={saving} onClick={onClose}>{readOnly ? "Close" : "Cancel"}</Button>
          {readOnly ? null : <Button type="button" className="min-h-11 bg-brand text-brand-ink" disabled={saving || loading || badRow || changed.length === 0} onClick={() => void save()}>{saving ? "Saving..." : "Save machines"}</Button>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function fingerprint(rows: Row[]) {
  return JSON.stringify(rows.map((r) => [r.machineId, Number(r.hours)]));
}
