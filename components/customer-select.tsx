"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { auditEvent } from "@/lib/audit";
import { DEMO_MODE } from "@/lib/demo";
import { fetchPickerCustomers, loadDemoCustomers, loadPickerNames, pickerOptions, saveCustomer } from "@/lib/customers";
import { friendlyError } from "@/lib/friendly-error";
import { useSaving } from "@/lib/use-saving";
import { ValidationError } from "@/lib/validation/schemas";

const ADD_NEW = "__add_new__";

/** Said under the picker when the customer list (or which customers are archived) couldn't be read. */
export const PICKER_LOAD_FAILED = "Couldn't load the customer list, so no customer can be picked. Nothing was changed.";

type CustomerSelectProps = {
  name: string;
  defaultValue?: string;
  value?: string;
  onValueChange?: (name: string) => void;
  required?: boolean;
  className?: string;
};

/**
 * The picker itself (no loading): the names, or none with the error and Retry when the load failed. The document's own customer
 * stays shown either way. Exported for tests.
 */
export function CustomerSelectView({ name, required, className, current, names, failed, onChoose, onRetry }: {
  name: string;
  required?: boolean;
  className?: string;
  current: string;
  names: string[];
  failed: boolean;
  onChoose: (value: string) => void;
  onRetry: () => void;
}) {
  return (
    <>
      <select
        name={name}
        required={required}
        value={current}
        onChange={(event) => onChoose(event.target.value)}
        className={className ?? "h-9 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"}
      >
        <option value="">{failed ? "Couldn't load customers" : "Select customer..."}</option>
        {pickerOptions(failed ? [] : names, current).map((customer) => <option key={customer} value={customer}>{customer}</option>)}
        {failed ? null : <option value={ADD_NEW}>+ Add new customer</option>}
      </select>
      {failed ? (
        <p role="alert" className="mt-1 text-sm text-red-700" data-testid="customer-picker-error">
          {PICKER_LOAD_FAILED} <button type="button" className="font-semibold underline" onClick={onRetry}>Retry</button>
        </p>
      ) : null}
    </>
  );
}

/**
 * Native select of customers that submits the customer NAME under `name`,
 * so existing FormData-based forms keep working. Includes "+ Add new customer". Archived customers are not offered.
 */
export function CustomerSelect({ name, defaultValue = "", value, onValueChange, required, className }: CustomerSelectProps) {
  const [names, setNames] = useState<string[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [internal, setInternal] = useState(defaultValue);
  const [dialogOpen, setDialogOpen] = useState(false);
  const { saving, run } = useSaving();
  const current = value ?? internal;

  const load = useCallback(async () => {
    // Archived customers (100) are left out; a document that already names one still shows it (pickerOptions). Fails closed: if
    // the list or the archive choices can't be read, no customer is offered (demo mode keeps its placeholder list).
    const result = await loadPickerNames(fetchPickerCustomers);
    setLoadFailed(result.failed);
    setNames(result.failed && DEMO_MODE ? (await loadDemoCustomers()).map((c) => c.name) : result.names);
  }, []);

  useEffect(() => { void load(); }, [load]);

  function choose(next: string) {
    if (next === ADD_NEW) { setDialogOpen(true); return; }
    setInternal(next);
    onValueChange?.(next);
  }

  async function createCustomer(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    const form = new FormData(event.currentTarget);
    const customerName = String(form.get("name") || "").trim();
    if (!customerName) { toast.error("Enter a customer name."); return; }
    await run(async () => {
      try {
        const saved = await saveCustomer({
          name: customerName,
          contactName: String(form.get("contact_name") || ""),
          email: String(form.get("email") || ""),
          phone: String(form.get("phone") || ""),
          address: "",
          notes: "",
        });
        void auditEvent({ action: "CREATE", entityTable: "customers", entityId: saved.id, newData: saved });
        setNames((list) => [...new Set([...list, saved.name])].sort((a, b) => a.localeCompare(b)));
        setInternal(saved.name);
        onValueChange?.(saved.name);
        setDialogOpen(false);
        toast.success(`Customer ${saved.name} added`);
      } catch (err) {
        toast.error(err instanceof ValidationError ? err.message : friendlyError(err, "Could not add customer"));
      }
    });
  }

  return (
    <>
      <CustomerSelectView name={name} required={required} className={className} current={current} names={names} failed={loadFailed && !DEMO_MODE}
        onChoose={choose} onRetry={() => void load()} />
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add new customer</DialogTitle><DialogDescription>Saved to your customer list and selected automatically.</DialogDescription></DialogHeader>
          <form onSubmit={createCustomer} className="grid gap-3">
            <Input name="name" placeholder="Customer name" required />
            <Input name="contact_name" placeholder="Contact name" />
            <div className="grid gap-3 md:grid-cols-2"><Input name="email" type="email" placeholder="Email" /><Input name="phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="Phone" /></div>
            <Button type="submit" disabled={saving} className="bg-brand text-brand-ink hover:bg-brand-hover">{saving ? "Saving..." : "Add customer"}</Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
