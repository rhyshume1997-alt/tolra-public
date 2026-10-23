"use client";

import { useEffect, useState } from "react";
import { suppliersEmptyHint } from "@/lib/empty-hints";
import { toast } from "sonner";
import { Pencil, Plus, Trash2 } from "lucide-react";

import { ColumnToggle } from "@/components/column-toggle";
import { StatusBadge } from "@/components/status-badge";
import { ViewSwitcher } from "@/components/view-switcher";
import { ListToolbar } from "@/components/list-toolbar";
import { RoleGate } from "@/components/role-gate";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useColumnVisibility } from "@/lib/org-settings";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { auditEvent } from "@/lib/audit";
import { DEMO_MODE } from "@/lib/demo";
import { friendlyError } from "@/lib/friendly-error";
import { exportSpreadsheet } from "@/lib/export-records";
import { SUPPLIER_COLUMNS } from "@/lib/import-columns";
import { exportAllTitle } from "@/lib/spreadsheet";
import { supabase } from "@/lib/supabase";
import { useSaving } from "@/lib/use-saving";
import { deleteSupplierFromSupabase, fetchSuppliersFromSupabase, saveSupplierToSupabase, type SupplierRecord } from "@/lib/supabase-business";
import { canChangeSupplierStatus, isSupplierStatus, SUPPLIER_STATUS_BADGE, SUPPLIER_STATUS_LABELS, SUPPLIER_STATUSES } from "@/lib/supplier-status";
import { useUser } from "@/lib/use-user";
import { useViewMode } from "@/lib/view-mode";
import { ValidationError } from "@/lib/validation/schemas";

// Placeholder rows, shown only when DEMO_MODE is on and Supabase is not configured.
const demoSuppliers: SupplierRecord[] = [
  { name: "Steel Supplies", email: "sales@steelsupplies.example" },
  { name: "Industrial Metals", email: "sales@industrialmetals.example" },
  { name: "Copper & Brass", email: "sales@copperbrass.example" },
  { name: "Aerospace Materials", email: "orders@aerospacematerials.example" },
  { name: "MetalSupplies", email: "orders@metalsupplies.example" },
];

export default function SuppliersPage() {
  const { isVisible } = useColumnVisibility("suppliers");
  // Cards / List / Table, remembered per person (lib/view-mode; styles in app/globals.css [data-view]).
  const [view, setView] = useViewMode("suppliers", "table");
  const [suppliers, setSuppliers] = useState<SupplierRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SupplierRecord | null>(null);
  const { saving, run } = useSaving();
  /** The status (migration 082) is offered once the database has it: some supplier was read with one, or this one was. */
  const statusAvailable = suppliers.some((supplier) => supplier.supplierStatus !== undefined);
  /** Only an admin changes a status (the database refuses anyone else); the office sees it, read only, and never sends it. */
  const { activeRole } = useUser();
  const canSetStatus = canChangeSupplierStatus(activeRole);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setSuppliers(!supabase && DEMO_MODE ? demoSuppliers : await fetchSuppliersFromSupabase());
    } catch (err) {
      setError(friendlyError(err, "Couldn't load suppliers."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") || "").trim();
    const email = String(form.get("email") || "").trim();
    if (!name) { toast.error("Enter a supplier name."); return; }
    if (email && !email.includes("@")) { toast.error("Enter a valid email address."); return; }
    await run(async () => {
      try {
        const saved = await saveSupplierToSupabase({
          id: editing.id,
          name,
          email,
          contactName: String(form.get("contact_name") || "").trim(),
          phone: String(form.get("phone") || "").trim(),
          notes: String(form.get("notes") || "").trim(),
          ...(isSupplierStatus(form.get("supplier_status")) ? { supplierStatus: form.get("supplier_status") as SupplierRecord["supplierStatus"] } : {}),
        });
        void auditEvent({ action: editing.id ? "UPDATE" : "CREATE", entityTable: "suppliers", entityId: saved.id, oldData: editing.id ? editing : undefined, newData: saved });
        toast.success(editing.id ? "Supplier updated" : "Supplier added");
        setEditing(null);
        await load();
      } catch (err) {
        toast.error(err instanceof ValidationError ? err.message : friendlyError(err, "Could not save supplier"));
      }
    });
  }

  async function remove(supplier: SupplierRecord) {
    if (!window.confirm(`Delete supplier "${supplier.name}"? This can't be undone.`)) return;
    await run(async () => {
      try {
        await deleteSupplierFromSupabase(supplier);
        void auditEvent({ action: "DELETE", entityTable: "suppliers", entityId: supplier.id, oldData: supplier });
        toast.success(`${supplier.name} deleted`);
        await load();
      } catch (err) {
        toast.error(friendlyError(err, "Could not delete supplier"));
      }
    });
  }

  return (
    <RoleGate allowed={["admin", "office"]}>
      <div className="space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div><h1 className="page-title">Suppliers</h1><p className="mt-2 text-sm text-slate-500">The companies we buy from. Used on purchase orders.</p></div>
          <div className="flex flex-wrap gap-2"><ColumnToggle tableKey="suppliers" /><ViewSwitcher value={view} onChange={setView} /><Button className="min-h-11 bg-brand text-brand-ink hover:bg-brand-hover" onClick={() => setEditing({ name: "", email: "" })}><Plus className="size-4" /> New supplier</Button></div>
        </div>
        <ListToolbar
          visibleCount={suppliers.length}
          selectedCount={0}
          buttonClassName="min-h-11"
          exports={[
            { label: "CSV", title: exportAllTitle("supplier", suppliers.length), onSelect: () => void exportSpreadsheet("csv", "Suppliers", SUPPLIER_COLUMNS, suppliers, "suppliers") },
            { label: "Excel", title: exportAllTitle("supplier", suppliers.length), onSelect: () => void exportSpreadsheet("xlsx", "Suppliers", SUPPLIER_COLUMNS, suppliers, "suppliers") },
          ]}
        />
        {error ? <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error} <button onClick={load} className="font-semibold underline">Retry</button></div> : null}
        {loading ? <Skeleton className="h-72" /> : (
          <Card><CardContent className="p-0">
            <Table data-view={view}>
              <TableHeader className="hidden md:table-header-group"><TableRow>{isVisible("name") ? <TableHead>Name</TableHead> : null}{isVisible("contact") ? <TableHead>Contact</TableHead> : null}{isVisible("email") ? <TableHead>Email</TableHead> : null}{isVisible("phone") ? <TableHead>Phone</TableHead> : null}{isVisible("notes") ? <TableHead>Notes</TableHead> : null}{statusAvailable ? <TableHead>Status</TableHead> : null}<TableHead>Actions</TableHead></TableRow></TableHeader>
              <TableBody>
                {suppliers.map((supplier) => (
                  <TableRow key={supplier.id || supplier.name} className="block md:table-row">
                    {isVisible("name") ? <TableCell data-label="Name" className="block font-semibold md:table-cell">{supplier.name}</TableCell> : null}
                    {isVisible("contact") ? <TableCell data-label="Contact" className="block md:table-cell">{supplier.contactName || "-"}</TableCell> : null}
                    {isVisible("email") ? <TableCell data-label="Email" className="block md:table-cell">{supplier.email || "-"}</TableCell> : null}
                    {isVisible("phone") ? <TableCell data-label="Phone" className="block md:table-cell">{supplier.phone || "-"}</TableCell> : null}
                    {isVisible("notes") ? <TableCell data-label="Notes" className="block max-w-xs truncate md:table-cell">{supplier.notes || "-"}</TableCell> : null}
                    {statusAvailable ? <TableCell data-label="Status" className="block md:table-cell">{supplier.supplierStatus ? <StatusBadge data-testid="supplier-status" status={SUPPLIER_STATUS_BADGE[supplier.supplierStatus]} label={SUPPLIER_STATUS_LABELS[supplier.supplierStatus]} /> : "-"}</TableCell> : null}
                    <TableCell data-actions className="block md:table-cell"><div className="flex flex-wrap items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => setEditing(supplier)} disabled={!supplier.id}><Pencil className="size-3.5" /> Edit</Button>
                      <Button variant="outline" size="sm" onClick={() => void remove(supplier)} disabled={!supplier.id || saving}><Trash2 className="size-3.5" /> Delete</Button>
                    </div></TableCell>
                  </TableRow>
                ))}
                {!suppliers.length ? <TableRow><TableCell colSpan={7} className="py-8 text-center text-slate-500">No suppliers yet. {suppliersEmptyHint()}</TableCell></TableRow> : null}
              </TableBody>
            </Table>
          </CardContent></Card>
        )}
        <Dialog open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>{editing?.id ? "Edit supplier" : "Add supplier"}</DialogTitle><DialogDescription>Supplier contact details.</DialogDescription></DialogHeader>
            {editing ? (
              <form key={editing.id || "new"} onSubmit={submit} className="grid gap-3">
                <Input name="name" placeholder="Supplier name" defaultValue={editing.name} required />
                <Input name="contact_name" placeholder="Contact name" defaultValue={editing.contactName} />
                <div className="grid gap-3 md:grid-cols-2"><Input name="email" type="email" placeholder="Email" defaultValue={editing.email} /><Input name="phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="Phone" defaultValue={editing.phone} /></div>
                <Textarea name="notes" placeholder="Notes" defaultValue={editing.notes} />
                {canSetStatus && (editing.supplierStatus !== undefined || (!editing.id && statusAvailable)) ? (
                  <label className="grid gap-1.5 text-sm font-medium text-slate-700">Status
                    <select name="supplier_status" aria-label="Status" defaultValue={editing.supplierStatus ?? "approved"} className="h-11 rounded-lg border px-3">
                      {SUPPLIER_STATUSES.map((status) => <option key={status} value={status}>{SUPPLIER_STATUS_LABELS[status]}</option>)}
                    </select>
                    <span className="text-xs font-normal text-slate-500">Conditional: a warning when a purchase order to it is issued. Blocked: purchase orders to it can&apos;t be issued.</span>
                  </label>
                ) : null}
                {!canSetStatus && editing.supplierStatus !== undefined ? (
                  <p data-testid="supplier-status-read-only" className="flex flex-wrap items-center gap-2 text-sm text-slate-600">Status
                    <StatusBadge status={SUPPLIER_STATUS_BADGE[editing.supplierStatus]} label={SUPPLIER_STATUS_LABELS[editing.supplierStatus]} />
                    <span className="text-xs text-slate-500">Only an admin changes it.</span>
                  </p>
                ) : null}
                <Button type="submit" disabled={saving} className="bg-brand text-brand-ink hover:bg-brand-hover">{saving ? "Saving..." : "Save Supplier"}</Button>
              </form>
            ) : null}
          </DialogContent>
        </Dialog>
      </div>
    </RoleGate>
  );
}
