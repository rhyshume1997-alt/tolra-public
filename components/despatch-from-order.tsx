"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { auditEvent } from "@/lib/audit";
import { toDateInput } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import { jobReadyForDeliveryNote } from "@/lib/job-delivery-note";
import { supabase } from "@/lib/supabase";

type Option = { id: string; label: string; blocked?: string };
/** held / available (migration 037): only the part of a job in rework, or waiting for replacements, is held; the rest may go. */
type Line = { line_id: string; description: string; ordered: number; despatched: number; remaining: number; held: number; available: number; reason: string | null };

/**
 * A delivery note made from a sales order, or from a job (the order it came from), with the quantity despatched on each line
 * (migration 034). What was ordered, what is already on delivery notes and what remains come from the database, which also
 * refuses more than remains. No invoice number is needed first.
 */
export function DespatchFromOrder({ source, presetId, onCreated }: { source: "order" | "job"; /** Already chosen (for example an invoice's job): the picker is skipped and the lines load straight away. */ presetId?: string; onCreated: () => void }) {
  const today = toDateInput(new Date());
  const [options, setOptions] = useState<Option[]>([]);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [picked, setPicked] = useState("");
  const [lines, setLines] = useState<Line[] | null>(null);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [shipDate, setShipDate] = useState(today);
  const [taxDate, setTaxDate] = useState(today);
  const [shipVia, setShipVia] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    setPicked("");
    setLines(null);
    setOptionsError(null);
    async function load() {
      if (!supabase || presetId) return;
      if (source === "order") {
        const { data, error: loadError } = await supabase.from("sales_orders").select("id, so_number, customer, status").in("status", ["open", "confirmed", "in_production", "converted"]).order("order_date", { ascending: false }).limit(200);
        if (!active) return;
        if (loadError) return setOptionsError(friendlyError(loadError, "Couldn't load the sales orders."));
        setOptions((data ?? []).map((row) => ({ id: String(row.id), label: `${row.so_number} - ${row.customer ?? ""}` })));
      } else {
        const { data, error: loadError } = await supabase.from("jobs").select("id, job_no, customer, inspected_at, stage").not("converted_from_sales_order_id", "is", null).order("created_at", { ascending: false }).limit(200);
        if (!active) return;
        if (loadError) return setOptionsError(friendlyError(loadError, "Couldn't load the jobs."));
        setOptions((data ?? []).map((row) => ({ id: String(row.id), label: `${row.job_no} - ${row.customer ?? ""}`, // A job in rework (or awaiting re-inspection) may still have a released part: the lines say what can go.
          blocked: jobReadyForDeliveryNote(row) ? undefined : "not inspected yet" })));
      }
    }
    void load();
    return () => { active = false; };
  }, [source, presetId]);

  useEffect(() => {
    if (presetId) void pick(presetId);
    // pick reads only the source and the id it is given; running it on every render would reload the lines.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, presetId]);

  async function pick(id: string) {
    setPicked(id);
    setLines(null);
    setError(null);
    if (!id || !supabase) return;
    const { data, error: rpcError } = await supabase.rpc("despatch_lines", { p_order: source === "order" ? id : null, p_job: source === "job" ? id : null });
    if (rpcError) return setError(friendlyError(rpcError, "Couldn't load the order's lines."));
    // What may go now, per line (migration 037): only the part of the job in rework, or waiting for replacements, is held.
    const release = await supabase.rpc("despatch_release", { p_order: source === "order" ? id : null, p_job: source === "job" ? id : null });
    if (release.error) return setError(friendlyError(release.error, "Couldn't load what can be despatched."));
    const held = new Map(((release.data ?? []) as Array<Record<string, unknown>>).map((row) => [String(row.line_id), row]));
    const rows = ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({ ...row, ...(held.get(String(row.line_id)) ?? {}) })).map((row): Line => ({
      line_id: String(row.line_id), description: String(row.description), ordered: Number(row.ordered), despatched: Number(row.despatched), remaining: Number(row.remaining),
      held: Number(row.held ?? 0), available: row.available === undefined || row.available === null ? Number(row.remaining) : Number(row.available),
      reason: typeof row.reason === "string" && row.reason ? row.reason : null,
    }));
    setLines(rows);
    setQuantities(Object.fromEntries(rows.map((row) => [row.line_id, row.available > 0 ? String(row.available) : ""])));
  }

  async function save() {
    if (!supabase || saving) return;
    const picks = (lines ?? []).map((row) => ({ line_id: row.line_id, quantity: Number(quantities[row.line_id] || 0) })).filter((row) => row.quantity > 0);
    if (!picks.length) return setError("Enter the quantity to despatch on at least one line.");
    setSaving(true);
    setError(null);
    try {
      const { data, error: rpcError } = await supabase.rpc("create_delivery_note", {
        p_order: source === "order" ? picked : null, p_job: source === "job" ? picked : null, p_ship_date: shipDate, p_tax_date: taxDate,
        p_ship_via: shipVia.trim() || null, p_notes: notes.trim() || null, p_lines: picks,
      });
      if (rpcError) throw rpcError;
      const made = data as { id: string; dn_number: string };
      void auditEvent({ action: "CREATE", entityTable: "delivery_notes", entityId: made.dn_number });
      toast.success(`Delivery note ${made.dn_number} created`);
      onCreated();
    } catch (err) {
      setError(friendlyError(err, "Couldn't create the delivery note. Nothing was saved."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-3">
      {presetId ? null : <label className="grid gap-1 text-xs text-slate-500">{source === "order" ? "Sales order" : "Job (made from a sales order)"}
        <select aria-label={source === "order" ? "Sales order" : "Job"} value={picked} onChange={(event) => void pick(event.target.value)} className="h-11 rounded-lg border px-3 text-sm text-slate-950">
          <option value="">{options.length ? "Choose..." : source === "order" ? "No open sales orders" : "No jobs made from orders"}</option>
          {options.map((option) => <option key={option.id} value={option.id} disabled={Boolean(option.blocked)}>{option.label}{option.blocked ? ` (${option.blocked})` : ""}</option>)}
        </select>
      </label>}
      {optionsError ? <p role="alert" className="text-sm text-red-700">{optionsError}</p> : null}
      {picked && !lines && !error ? <p className="text-sm text-slate-500" role="status">Loading the lines...</p> : null}
      {lines ? [...new Set(lines.map((row) => row.reason).filter((reason): reason is string => Boolean(reason && reason.length > 80)))].map((reason) => (
        <p key={reason} role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{reason}</p>
      )) : null}
      {lines ? (
        lines.length ? (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm" aria-label="Lines to despatch">
              <thead><tr className="text-left text-xs text-slate-500"><th className="p-2">Line</th><th className="p-2 text-right">Ordered</th><th className="p-2 text-right">On notes</th><th className="p-2 text-right">Left</th><th className="p-2 text-right">Held</th><th className="p-2 text-right">This note</th></tr></thead>
              <tbody>
                {lines.map((row) => (
                  <tr key={row.line_id} className="border-t">
                    <td className="p-2">{row.description}</td>
                    <td className="p-2 text-right">{row.ordered}</td>
                    <td className="p-2 text-right">{row.despatched}</td>
                    <td className="p-2 text-right font-medium">{row.remaining}</td>
                    <td className="p-2 text-right" title={row.reason ?? "In rework, waiting for replacements, or not yet passed"}>
                      {row.held > 0 ? <>{row.held}{row.reason && row.reason.length <= 80 ? <span className="block text-xs text-slate-500">{row.reason}</span> : null}</> : ""}
                    </td>
                    <td className="p-2 text-right">
                      <Input aria-label={`Quantity to despatch: ${row.description}`} className="ml-auto h-8 w-24 text-right" type="number" inputMode="decimal" min="0" max={row.available} step="any" disabled={row.available <= 0}
                        value={quantities[row.line_id] ?? ""} onChange={(event) => setQuantities((current) => ({ ...current, [row.line_id]: event.target.value }))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="text-sm text-slate-500">This job didn&apos;t come from a sales order, so there is nothing to despatch from. Use &quot;Without an order&quot;.</p>
      ) : null}
      {lines?.length ? (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1 text-sm text-slate-600">Ship date<Input type="date" required value={shipDate} onChange={(event) => setShipDate(event.target.value)} /></label>
            <label className="grid gap-1 text-sm text-slate-600">Tax date<Input type="date" required value={taxDate} onChange={(event) => setTaxDate(event.target.value)} /></label>
          </div>
          <Input aria-label="Ship via" maxLength={100} placeholder="Ship via" value={shipVia} onChange={(event) => setShipVia(event.target.value)} />
          <Textarea aria-label="Notes" maxLength={2000} placeholder="Notes" value={notes} onChange={(event) => setNotes(event.target.value)} />
        </>
      ) : null}
      {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
      <Button type="button" disabled={saving || !lines?.length} onClick={() => void save()} className="bg-brand text-brand-ink">{saving ? "Saving…" : "Save Delivery Note"}</Button>
    </div>
  );
}
