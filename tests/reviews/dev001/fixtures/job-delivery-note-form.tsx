"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { auditEvent } from "@/lib/audit";
import { toDateInput } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import { JOB_DELIVERY_NOTE_RPC, buildJobDeliveryNoteArgs, customerForJob } from "./job-delivery-note-no-order";
import { supabase } from "@/lib/supabase";

type Customer = { id: string; name: string | null };

/**
 * A delivery note for a job that did not come from a sales order (release 147): the lines are typed here, and the note is linked to the
 * job and to the chosen customer record by key. The customer record named as the job's customer is chosen already; the database refuses
 * a different one. One request id per form, and one save at a time, so a double click makes one note.
 */
export function JobDeliveryNoteForm({ job, onCreated }: { job: { id: string; job_no: string; customer: string }; onCreated: () => void }) {
  const today = toDateInput(new Date());
  const [requestId] = useState(() => crypto.randomUUID());
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [customerId, setCustomerId] = useState("");
  const [lines, setLines] = useState([{ description: "", quantity: "" }]);
  const [shipDate, setShipDate] = useState(today);
  const [taxDate, setTaxDate] = useState(today);
  const [shipVia, setShipVia] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    let active = true;
    if (!supabase) return;
    void supabase.from("customers").select("id, name").order("name").limit(2000).then(({ data, error: readError }) => {
      if (!active) return;
      if (readError) return setError(friendlyError(readError, "Couldn't load the customers."));
      const rows = (data ?? []) as Customer[];
      setCustomers(rows);
      setCustomerId((current) => current || customerForJob(job.customer, rows) || "");
    });
    return () => { active = false; };
  }, [job.customer]);

  async function save() {
    if (!supabase || inFlight.current) return;
    const built = buildJobDeliveryNoteArgs({ jobId: job.id, customerId, requestId, shipDate, taxDate, shipVia, notes, lines });
    if (!built.ok) return setError(built.error);
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      const { data, error: rpcError } = await supabase.rpc(JOB_DELIVERY_NOTE_RPC, built.args);
      if (rpcError) throw rpcError;
      const made = data as { id: string; dn_number: string; replayed: boolean };
      if (!made.replayed) void auditEvent({ action: "CREATE", entityTable: "delivery_notes", entityId: made.dn_number });
      toast.success(`Delivery note ${made.dn_number} created`);
      onCreated();
    } catch (err) {
      setError(friendlyError(err, "Couldn't create the delivery note. Nothing was saved."));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  const setLine = (index: number, key: "description" | "quantity", value: string) => setLines((rows) => rows.map((row, i) => (i === index ? { ...row, [key]: value } : row)));

  return (
    <div className="grid gap-3">
      <label className="grid gap-1 text-xs text-slate-500">Customer
        <select aria-label="Customer" value={customerId} onChange={(event) => setCustomerId(event.target.value)} className="h-11 rounded-lg border px-3 text-sm text-slate-950">
          <option value="">{customers === null ? "Loading..." : customers.length ? "Choose..." : "No customers yet: add one on the Customers page"}</option>
          {(customers ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <div className="grid gap-2">
        {lines.map((row, index) => (
          <div key={index} className="flex gap-2">
            <Input aria-label={`Description ${index + 1}`} maxLength={1000} placeholder="Description" value={row.description} onChange={(event) => setLine(index, "description", event.target.value)} />
            <Input aria-label={`Quantity ${index + 1}`} className="w-24 text-right" type="number" inputMode="decimal" min="0" step="any" placeholder="Qty" value={row.quantity} onChange={(event) => setLine(index, "quantity", event.target.value)} />
          </div>
        ))}
        {lines.length < 200 ? <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => setLines((rows) => [...rows, { description: "", quantity: "" }])}>Add line</Button> : null}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1 text-sm text-slate-600">Ship date<Input type="date" required value={shipDate} onChange={(event) => setShipDate(event.target.value)} /></label>
        <label className="grid gap-1 text-sm text-slate-600">Tax date<Input type="date" required value={taxDate} onChange={(event) => setTaxDate(event.target.value)} /></label>
      </div>
      <Input aria-label="Ship via" maxLength={100} placeholder="Ship via" value={shipVia} onChange={(event) => setShipVia(event.target.value)} />
      <Textarea aria-label="Notes" maxLength={2000} placeholder="Notes" value={notes} onChange={(event) => setNotes(event.target.value)} />
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      <Button type="button" disabled={saving} onClick={() => void save()} className="bg-brand text-brand-ink">{saving ? "Saving…" : "Save Delivery Note"}</Button>
    </div>
  );
}
