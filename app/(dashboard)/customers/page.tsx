"use client";

import { useEffect, useMemo, useState } from "react";
import { customersEmptyHint } from "@/lib/empty-hints";
import { toast } from "sonner";
import { Pencil, Plus } from "lucide-react";

import { ColumnToggle } from "@/components/column-toggle";
import { ArchiveButton, PhaseFilter } from "@/components/phase-filter";
import { ListToolbar } from "@/components/list-toolbar";
import { ViewSwitcher } from "@/components/view-switcher";
import { useViewMode } from "@/lib/view-mode";
import { RoleGate } from "@/components/role-gate";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useColumnVisibility } from "@/lib/org-settings";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { type Phase, type PhaseFilterValue, useArchive } from "@/lib/archive";
import { auditEvent } from "@/lib/audit";
import { fetchKnownCustomers, loadDemoCustomers, newCustomerDraft, saveCustomer, type CustomerRecord, type KnownCustomer } from "@/lib/customers";
import { DEMO_MODE } from "@/lib/demo";
import { friendlyError } from "@/lib/friendly-error";
import { exportSpreadsheet } from "@/lib/export-records";
import { CUSTOMER_COLUMNS } from "@/lib/import-columns";
import { exportAllTitle } from "@/lib/spreadsheet";
import { gbp } from "@/lib/money";
import { supabase } from "@/lib/supabase";
import { useSaving } from "@/lib/use-saving";
import { useDatabaseHas073 } from "@/lib/use-database-has-073";
import { ValidationError } from "@/lib/validation/schemas";

const NOT_SAVED_LABEL = "Not saved as a customer yet";
const DOCUMENT_NAMES_TRUNCATED = "Only part of the names found on RFQs, quotes, sales orders and invoices could be listed: some may be missing here.";

export default function CustomersPage() {
  const { isVisible } = useColumnVisibility("customers");
  // Cards / List / Table, remembered per person (lib/view-mode; styles in app/globals.css [data-view]).
  const [view, setView] = useViewMode("customers", "table");
  const [customers, setCustomers] = useState<KnownCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CustomerRecord | null>(null);
  /** Customer credit by customer name (migration 034): what they have paid or been credited beyond their invoices. */
  const [credits, setCredits] = useState<Map<string, number>>(new Map());
  /** Names on documents with no customer record are listed but are not exported: an export holds saved customers only. */
  const savedCustomers = customers.filter((customer) => !customer.notSaved);
  /** A document table had more rows than the list reads: some names found only on documents may be missing. */
  const [namesTruncated, setNamesTruncated] = useState(false);
  const { saving, run } = useSaving();
  /** The customer's mobile needs migration 073: a new customer offers it only once the database has it. */
  const has073 = useDatabaseHas073() === true;
  // Archive / Unarchive (migration 100, as 028's records): an archived customer leaves the pickers and this default list; nothing is
  // deleted, and documents that name it keep showing it. Names found only on documents can't be archived (there is no record).
  const archive = useArchive("customers");
  const [phase, setPhase] = useState<PhaseFilterValue>("open");
  const phaseFor = (customer: KnownCustomer): Phase => (customer.id && archive.manual.get(customer.id) === "archived" ? "archived" : "open");
  const phaseCounts = useMemo(() => {
    const archived = customers.filter((customer) => customer.id && archive.manual.get(customer.id) === "archived").length;
    return { open: customers.length - archived, done: 0, archived };
  }, [customers, archive.manual]);
  const shown = customers.filter((customer) => phase === "all" || phaseFor(customer) === phase);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      // Trust the database, including an empty result. Sample rows only exist in DEMO_MODE.
      if (!supabase && DEMO_MODE) setCustomers(await loadDemoCustomers());
      else {
        const known = await fetchKnownCustomers();
        setCustomers(known.customers);
        setNamesTruncated(known.documentNamesTruncated);
      }
      if (supabase) {
        const { data } = await supabase.rpc("customer_credit");
        setCredits(new Map(((data ?? []) as Array<{ customer: string; credit: number }>).map((row) => [row.customer, Number(row.credit)])));
      }
    } catch (err) {
      setError(friendlyError(err, "Couldn't load customers."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  /** A new customer's form; the traceable default (082) is offered once the database has it (a saved customer was read with it). */
  const newDraft = (name: string): CustomerRecord => ({
    ...newCustomerDraft(name, has073),
    ...(customers.some((customer) => customer.traceableDefault !== undefined) ? { traceableDefault: false } : {}),
  });

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const form = new FormData(event.currentTarget);
    const next: CustomerRecord = {
      id: editing.id,
      name: String(form.get("name") || "").trim(),
      contactName: String(form.get("contact_name") || ""),
      email: String(form.get("email") || ""),
      phone: String(form.get("phone") || ""),
      address: String(form.get("address") || ""),
      notes: String(form.get("notes") || ""),
      // Sent only when the form offered it (it was read, or this is a new customer and the database has it).
      ...(editing.mobile === undefined ? {} : { mobile: String(form.get("mobile") || "") }),
      // 082: sent only when it was read (or offered to a new customer once the database has it).
      ...(editing.traceableDefault === undefined ? {} : { traceableDefault: form.get("traceable_default") === "on" }),
    };
    if (!next.name) { toast.error("Enter a customer name."); return; }
    await run(async () => {
      try {
        const saved = await saveCustomer(next);
        void auditEvent({ action: editing.id ? "UPDATE" : "CREATE", entityTable: "customers", entityId: saved.id, oldData: editing.id ? editing : undefined, newData: saved });
        toast.success(editing.id ? "Customer updated" : "Customer added");
        setEditing(null);
        await load();
      } catch (err) {
        toast.error(err instanceof ValidationError ? err.message : friendlyError(err, "Could not save customer"));
      }
    });
  }

  return (
    <RoleGate allowed={["admin", "office"]}>
      <div className="space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div><h1 className="page-title">Customers</h1><p className="mt-2 text-sm text-slate-500">The companies we sell to. Used on quotes, sales orders and invoices.</p></div>
          <div className="flex flex-wrap items-center gap-2"><ColumnToggle tableKey="customers" /><ViewSwitcher value={view} onChange={setView} /><Button className="min-h-11 bg-brand text-brand-ink hover:bg-brand-hover" onClick={() => setEditing(newDraft(""))}><Plus className="size-4" /> New customer</Button></div>
        </div>
        <ListToolbar
          visibleCount={shown.length}
          selectedCount={0}
          buttonClassName="min-h-11"
          exports={[
            { label: "CSV", title: exportAllTitle("customer", savedCustomers.length), onSelect: () => void exportSpreadsheet("csv", "Customers", CUSTOMER_COLUMNS, savedCustomers, "customers") },
            { label: "Excel", title: exportAllTitle("customer", savedCustomers.length), onSelect: () => void exportSpreadsheet("xlsx", "Customers", CUSTOMER_COLUMNS, savedCustomers, "customers") },
          ]}
        />
        <PhaseFilter value={phase} onChange={setPhase} counts={phaseCounts} phases={["open", "archived", "all"]} labels={{ open: "Active" }} />
        {error ? <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error} <button onClick={load} className="font-semibold underline">Retry</button></div> : null}
        {namesTruncated ? <p className="text-sm text-amber-800" data-testid="customer-names-truncated">{DOCUMENT_NAMES_TRUNCATED}</p> : null}
        {loading ? <Skeleton className="h-72" /> : (
          <Card><CardContent className="p-0">
            <Table data-view={view}>
              <TableHeader className="hidden md:table-header-group"><TableRow>{isVisible("name") ? <TableHead>Name</TableHead> : null}{isVisible("contact") ? <TableHead>Contact</TableHead> : null}{isVisible("email") ? <TableHead>Email</TableHead> : null}{isVisible("phone") ? <TableHead>Phone</TableHead> : null}{isVisible("address") ? <TableHead>Address</TableHead> : null}<TableHead>Actions</TableHead></TableRow></TableHeader>
              <TableBody>
                {shown.map((customer) => (
                  <TableRow key={customer.id || customer.name} className="block md:table-row">
                    {isVisible("name") ? <TableCell data-label="Name" className="block font-semibold md:table-cell">{customer.name}{customer.notSaved ? <span className="block text-xs font-normal text-slate-500" data-testid="customer-not-saved">{NOT_SAVED_LABEL}</span> : null}{credits.get(customer.name) ? <span className="block text-xs font-normal text-amber-700" data-testid="customer-credit">Customer credit {gbp(credits.get(customer.name) ?? 0, 2)}</span> : null}</TableCell> : null}
                    {isVisible("contact") ? <TableCell data-label="Contact" className="block md:table-cell">{customer.contactName || "-"}</TableCell> : null}
                    {isVisible("email") ? <TableCell data-label="Email" className="block md:table-cell">{customer.email || "-"}</TableCell> : null}
                    {isVisible("phone") ? <TableCell data-label="Phone" className="block md:table-cell">{customer.phone || "-"}{customer.mobile ? <span className="block text-xs text-slate-600">Mobile {customer.mobile}</span> : null}</TableCell> : null}
                    {isVisible("address") ? <TableCell data-label="Address" className="block md:table-cell">{customer.address || "-"}</TableCell> : null}
                    <TableCell data-actions className="block md:table-cell">{customer.notSaved
                      ? <Button variant="outline" size="sm" onClick={() => setEditing(newDraft(customer.name))}><Plus className="size-3.5" /> Add customer</Button>
                      : <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => setEditing(customer)} disabled={!customer.id} title={customer.id ? undefined : "Demo data cannot be edited"}><Pencil className="size-3.5" /> Edit</Button>{archive.canManage ? <ArchiveButton id={customer.id} phase={phaseFor(customer)} manual={customer.id ? archive.manual.get(customer.id) : undefined} onSet={archive.setState} /> : null}</div>}</TableCell>
                  </TableRow>
                ))}
                {!customers.length ? <TableRow><TableCell colSpan={6} className="py-8 text-center text-slate-500">No customers yet. {customersEmptyHint()}</TableCell></TableRow> : null}
                {customers.length && !shown.length ? <TableRow><TableCell colSpan={6} className="py-8 text-center text-slate-500">{phase === "archived" ? "No archived customers." : "Every customer is archived: see Show > Archived."}</TableCell></TableRow> : null}
              </TableBody>
            </Table>
          </CardContent></Card>
        )}
        <Dialog open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>{editing?.id ? "Edit customer" : "Add customer"}</DialogTitle><DialogDescription>Customer contact details.</DialogDescription></DialogHeader>
            {editing ? (
              <form key={editing.id || "new"} onSubmit={submit} className="grid gap-3">
                <Input name="name" placeholder="Customer name" defaultValue={editing.name} required />
                <Input name="contact_name" placeholder="Contact name" defaultValue={editing.contactName} />
                <div className="grid gap-3 md:grid-cols-2"><Input name="email" type="email" placeholder="Email" defaultValue={editing.email} /><Input name="phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="Phone" defaultValue={editing.phone} /></div>
                {editing.mobile !== undefined ? <Input name="mobile" type="tel" inputMode="tel" autoComplete="tel" placeholder="Mobile" maxLength={40} defaultValue={editing.mobile} /> : null}
                <Textarea name="address" placeholder="Address" defaultValue={editing.address} />
                <Textarea name="notes" placeholder="Notes" defaultValue={editing.notes} />
                {editing.traceableDefault !== undefined ? (
                  <label className="flex items-start gap-2 text-sm text-slate-700">
                    <input type="checkbox" name="traceable_default" defaultChecked={editing.traceableDefault} className="mt-1 size-4" />
                    <span><span className="font-medium">Traceable material</span> <span className="block text-xs text-slate-500">New jobs for this customer need the material cert no. and heat/cast no. before the inspection can pass.</span></span>
                  </label>
                ) : null}
                <Button type="submit" disabled={saving} className="bg-brand text-brand-ink hover:bg-brand-hover">{saving ? "Saving..." : "Save Customer"}</Button>
              </form>
            ) : null}
          </DialogContent>
        </Dialog>
      </div>
    </RoleGate>
  );
}
