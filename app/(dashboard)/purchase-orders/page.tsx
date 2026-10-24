"use client";

import { ActivityPanel } from "@/components/activity-panel";
import { EmptyList } from "@/components/empty-list";
import { DocumentAttachments } from "@/components/document-attachments";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CircleCheck, Plus, ShoppingCart, TriangleAlert } from "lucide-react";

import { FilterBar } from "@/components/filter-bar";
import { ArchiveButton, PhaseFilter } from "@/components/phase-filter";
import { phaseOf, type PhaseFilterValue, useArchive } from "@/lib/archive";
import { ColumnToggle } from "@/components/column-toggle";
import { ListToolbar } from "@/components/list-toolbar";
import { ViewSwitcher } from "@/components/view-switcher";
import { useViewMode } from "@/lib/view-mode";
import { RoleGate } from "@/components/role-gate";
import { StatusBadge } from "@/components/status-badge";
import { purchaseOrderStatusKey } from "@/lib/status-colours";
import { Button } from "@/components/ui/button";
import { SelectBox } from "@/components/ui/select-box";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { PurchaseOrderPDF } from "@/components/pdf/PurchaseOrderPDF";
import { auditEvent } from "@/lib/audit";
import { requireCompanyProfile, useCompanyProfile } from "@/lib/company";
import { DEMO_MODE } from "@/lib/demo";
import { ListFilterNotice, useListFilter } from "@/components/list-filter-notice";
import { purchaseOrderMatchesFilter } from "@/lib/list-filter";
import { fmtDate, nowIso, toDateInput } from "@/lib/dates";
import { downloadPdf } from "@/lib/download-pdf";
import { friendlyError } from "@/lib/friendly-error";
import { type SupplierStatus, supplierKey, supplierOrderNotice } from "@/lib/supplier-status";
import { esc } from "@/lib/html";
import { documentTotals, gbp } from "@/lib/money";
import { PO_TOTAL_LABEL, purchaseOrderTotalIncVat } from "@/lib/purchase-order-total";
import { allocateNumber } from "@/lib/numbering";
import { openPrintPack } from "@/lib/print-pack";
import { exportSpreadsheet } from "@/lib/export-records";
import { PURCHASE_ORDER_COLUMNS } from "@/lib/import-columns";
import { exportScopeTitle } from "@/lib/spreadsheet";
import { useColumnVisibility } from "@/lib/org-settings";
import { supabase } from "@/lib/supabase";
import { fetchSuppliersFromSupabase, getCurrentOrganizationId } from "@/lib/supabase-business";
import { useSaving } from "@/lib/use-saving";
import { ValidationError, parseOrThrow, purchaseOrderSaveSchema, userMessage } from "@/lib/validation/schemas";
import { companyVat, fromVatChoice, type VatChoice } from "@/lib/vat";
import { VatRateSelect, VatToggle } from "@/components/vat-controls";
import { VatTotals } from "@/components/vat-totals";
import { purchaseOrdersEmptyHint, supplierPickerHint } from "@/lib/empty-hints";

type PoItem = { description?: string; qty?: number; unit_price?: number; vat_pct?: number; vat_exempt?: boolean };

type PurchaseOrderRow = {
  /** Database UUID (a string). Demo rows use a "demo-" id. */
  id: string;
  ref: string;
  supplier: string;
  /** ISO order date (YYYY-MM-DD). */
  date: string;
  /** ISO expected delivery date (YYYY-MM-DD) or "". */
  delivery: string;
  /** Order value, ex VAT. */
  value: number;
  /** "Add VAT" on this PO (POs created before the VAT options: off). */
  vatEnabled?: boolean;
  status: string;
  /** ISO timestamp someone confirmed the order was sent to the supplier (separate from issuing). */
  sentAt?: string;
  /** ISO timestamp the goods were received. */
  receivedAt?: string;
  /** Saved line items: { description, qty, unit_price } as written by the New PO form. */
  items?: PoItem[];
  notes?: string;
  demo?: boolean;
};

const PO_FILTER_LABELS: Record<string, string> = { late: "Purchase orders past their expected delivery" };
const OPEN_STATUSES = ["draft", "issued", "sent", "confirmed", "awaiting"];
const currency = (value: number) => gbp(value, 2);

/** Demo mode only: generic sample rows (not real company data). */
function demoPurchaseOrders(): PurchaseOrderRow[] {
  return [
    { id: "demo-1", demo: true, ref: "PO-0001", supplier: "MetalSupplies", date: "2026-05-09", delivery: "2026-05-14", value: 840, status: "sent" },
    { id: "demo-2", demo: true, ref: "PO-0002", supplier: "Steel Supplies", date: "2026-05-08", delivery: "2026-05-16", value: 1300, status: "awaiting" },
    { id: "demo-3", demo: true, ref: "PO-0003", supplier: "Aerospace Materials", date: "2026-05-02", delivery: "2026-05-08", value: 3720, status: "received", receivedAt: "2026-05-08T10:00:00.000Z" },
  ];
}

export default function PurchaseOrdersPage() {
  const { isVisible } = useColumnVisibility("purchase-orders");
  // Cards / List / Table, remembered per person (lib/view-mode; styles in app/globals.css [data-view]).
  const [view, setView] = useViewMode("purchase-orders", "table");
  const { profile: company } = useCompanyProfile();
  const vat = companyVat(company);
  // New PO: VAT follows the company settings until changed on the form.
  const [newVatOn, setNewVatOn] = useState<boolean | null>(null);
  const [newVatChoice, setNewVatChoice] = useState<VatChoice | null>(null);
  const [newQty, setNewQty] = useState("1");
  const [newUnit, setNewUnit] = useState("");
  const newPoVat = vat.registered && (newVatOn ?? true);
  const newPoChoice = newVatChoice ?? vat.defaultChoice;
  const { saving, run } = useSaving();
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [suppliers, setSuppliers] = useState<string[]>([]);
  /** Each supplier's status (migration 082), by supplierKey(name); empty before 082. The Issue dialog warns on a conditional or blocked one. */
  const [supplierStatuses, setSupplierStatuses] = useState<Map<string, SupplierStatus>>(new Map());
  const [suppliersError, setSuppliersError] = useState<string | null>(null);
  const [filters, setFilters] = useState(new Set(["all"]));
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [viewing, setViewing] = useState<PurchaseOrderRow | null>(null);
  const [editing, setEditing] = useState<PurchaseOrderRow | null>(null);
  // Issue a draft, or confirm an issued order was sent to the supplier: both asked for explicitly.
  const [poAction, setPoAction] = useState<{ po: PurchaseOrderRow; kind: "issue" | "sent" } | null>(null);
  /** A purchase order is raised when its draft is issued (082): the Issue dialog warns on a conditional supplier and stops a blocked one. */
  const issueNotice = poAction?.kind === "issue" ? supplierOrderNotice(supplierStatuses.get(supplierKey(poAction.po.supplier))) : null;
  const [editDraft, setEditDraft] = useState({ supplier: "", delivery: "", value: "", notes: "", vatOn: false });
  const [newOpen, setNewOpen] = useState(false);
  // Open / Done / Archived (lib/archive, migration 028): finished records move out of the way; nothing is deleted.
  const archive = useArchive("purchase_orders");
  const [phase, setPhase] = useState<PhaseFilterValue>("open");
  // /purchase-orders?filter=late (the dashboard's "View all"): only those orders, whatever Show says.
  const [listFilter, clearListFilter] = useListFilter("purchase-orders");
  const phaseFor = useCallback((po: (typeof purchaseOrders)[number]) => phaseOf({ final: ["received", "cancelled"].includes(po.status), finalDate: po.delivery || po.date }, po.id ? archive.manual.get(String(po.id)) : undefined, archive.months), [archive.manual, archive.months]);
  const phaseCounts = useMemo(() => ({ open: purchaseOrders.filter((x) => phaseFor(x) === "open").length, done: purchaseOrders.filter((x) => phaseFor(x) === "done").length, archived: purchaseOrders.filter((x) => phaseFor(x) === "archived").length }), [purchaseOrders, phaseFor]);
  const visible = useMemo(() => purchaseOrders.filter((po) => (listFilter ? purchaseOrderMatchesFilter(listFilter, po, toDateInput(new Date())) : (phase === "all" || phaseFor(po) === phase) && (filters.has("all") || filters.has(po.status)))), [filters, listFilter, purchaseOrders, phase, phaseFor]);

  // CSV / Excel: the selected orders if any, otherwise every order in the current filter; the import column spec.
  const exportScope = selectedIds.length ? purchaseOrders.filter((po) => selectedIds.includes(po.id)) : visible;
  const scopeTitle = exportScopeTitle("purchase order", selectedIds.length, visible.length);

  // Stat cards come from the loaded orders.
  const stats = useMemo(() => {
    const today = toDateInput(new Date());
    const month = today.slice(0, 7);
    const open = purchaseOrders.filter((po) => po.status !== "received");
    return {
      open: open.length,
      overdue: open.filter((po) => po.delivery && po.delivery < today).length,
      receivedMonth: purchaseOrders.filter((po) => po.status === "received" && po.receivedAt && toDateInput(po.receivedAt).slice(0, 7) === month).length,
    };
  }, [purchaseOrders]);

  const loadPurchaseOrders = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      if (!supabase) throw new Error("Supabase is not configured.");
      const { data, error } = await supabase
        .from("purchase_orders")
        .select("id, po_ref, po_number, supplier, order_date, expected_delivery, total_value, vat_enabled, status, items, notes, received_at, sent_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      // Trust the database, including an empty result.
      setPurchaseOrders((data ?? []).map((row): PurchaseOrderRow => ({
        id: String(row.id),
        ref: row.po_ref || row.po_number || `PO-${String(row.id).slice(0, 8)}`,
        supplier: row.supplier || "",
        date: row.order_date ? String(row.order_date).slice(0, 10) : "",
        delivery: row.expected_delivery ? String(row.expected_delivery).slice(0, 10) : "",
        value: Number(row.total_value || 0),
        vatEnabled: row.vat_enabled === true,
        status: row.status || "sent",
        receivedAt: row.received_at || undefined,
        sentAt: row.sent_at || undefined,
        items: Array.isArray(row.items) ? row.items : undefined,
        notes: row.notes || "",
      })));
    } catch (err) {
      setLoadError(friendlyError(err, "Couldn't load purchase orders."));
      setPurchaseOrders(DEMO_MODE ? demoPurchaseOrders() : []);
    } finally {
      setLoading(false);
    }
  }, []);

  /** Also run when New PO opens: a first load that failed (or came back empty before the session was ready) otherwise left the list empty until a reload. */
  const loadSuppliers = useCallback(async () => {
    try {
      const data = await fetchSuppliersFromSupabase();
      setSuppliers(data.map((supplier) => supplier.name));
      setSupplierStatuses(new Map(data.flatMap((supplier) => (supplier.supplierStatus ? [[supplierKey(supplier.name), supplier.supplierStatus] as const] : []))));
      setSuppliersError(null);
    } catch (err) {
      console.error(err);
      setSuppliersError("Couldn't load your suppliers.");
      if (DEMO_MODE) setSuppliers(["MetalSupplies", "Steel Supplies", "Aerospace Materials"]);
    }
  }, []);

  useEffect(() => {
    void loadSuppliers();
    void loadPurchaseOrders();
  }, [loadPurchaseOrders, loadSuppliers]);

  function setNewPoOpen(open: boolean) {
    setNewOpen(open);
    if (open) void loadSuppliers();
  }

  /** Writes columns to the given orders, then mirrors them on screen. Throws on failure. */
  async function persistPos(targets: PurchaseOrderRow[], columns: Record<string, unknown>, patch: Partial<PurchaseOrderRow>) {
    const real = targets.filter((po) => !po.demo);
    if (real.length) {
      if (!supabase) throw new Error("Supabase is not configured.");
      const { error } = await supabase.from("purchase_orders").update(columns).in("id", real.map((po) => po.id));
      if (error) throw error;
    } else if (targets.length && !DEMO_MODE) {
      throw new Error("Supabase is not configured.");
    }
    const ids = targets.map((po) => po.id);
    setPurchaseOrders((current) => current.map((po) => ids.includes(po.id) ? { ...po, ...patch } : po));
  }

  async function savePo(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    await run(async () => {
      try {
        if (!supabase) throw new Error("Supabase is not configured.");
        const input = parseOrThrow(purchaseOrderSaveSchema, {
          supplier: String(form.get("supplier") || ""),
          expectedDelivery: String(form.get("expected_delivery") || ""),
          notes: String(form.get("notes") || ""),
          lines: [{ description: String(form.get("description") || ""), quantity: Number(form.get("qty")), unitPrice: Number(form.get("unit_price")) }],
        });
        const line = input.lines[0];
        // total_value stays the ex-VAT order value; VAT (when on) is added on the printed PO.
        const total = documentTotals([{ quantity: line.quantity, unitPrice: line.unitPrice, vatPct: 0 }]).subtotal;
        const lineVat = fromVatChoice(newPoChoice);
        const organizationId = await getCurrentOrganizationId();
        const poRef = await allocateNumber("PO");
        const { error } = await supabase.from("purchase_orders").insert({
          organization_id: organizationId,
          po_ref: poRef,
          po_number: poRef,
          supplier: input.supplier,
          order_date: toDateInput(new Date()),
          expected_delivery: input.expectedDelivery || null,
          items: [{ description: line.description, qty: line.quantity, unit_price: line.unitPrice, vat_pct: lineVat.vatPct, vat_exempt: lineVat.vatExempt }],
          total_value: total,
          vat_enabled: newPoVat,
          // A draft: check it, then issue it (fixes supplier, items and value), then record when it was sent.
          status: "draft",
          notes: input.notes || null,
        });
        if (error) throw error;
        void auditEvent({ action: "CREATE", entityTable: "purchase_orders", entityId: poRef });
        toast.success(`Purchase order ${poRef} saved`);
        // Reset and close only after a successful save.
        formEl.reset();
        setNewVatOn(null);
        setNewVatChoice(null);
        setNewQty("1");
        setNewUnit("");
        setNewOpen(false);
        await loadPurchaseOrders();
      } catch (err) {
        toast.error(userMessage(err, "Could not save the purchase order. Nothing was saved."));
      }
    });
  }

  function startEdit(po: PurchaseOrderRow) {
    setEditDraft({ supplier: po.supplier, delivery: po.delivery, value: String(po.value), notes: po.notes || "", vatOn: Boolean(po.vatEnabled) && vat.registered });
    setEditing(po);
  }

  async function saveEdit() {
    const po = editing;
    if (!po) return;
    await run(async () => {
      try {
        const hasItems = Boolean(po.items?.some((item) => item.description));
        const value = hasItems ? po.value : Number(editDraft.value);
        const input = parseOrThrow(purchaseOrderSaveSchema, {
          supplier: editDraft.supplier,
          expectedDelivery: editDraft.delivery,
          notes: editDraft.notes,
          // The value is validated separately below; one placeholder line satisfies the shared schema.
          lines: [{ description: "-", quantity: 1, unitPrice: 0 }],
        });
        if (!Number.isFinite(value) || value < 0 || editDraft.value.trim() === "") throw new ValidationError("Enter a valid order value.");
        if (po.status !== "draft") {
          // Issued: supplier, items and value are fixed (migration 027); the delivery date and notes can still change.
          await persistPos([po], { expected_delivery: input.expectedDelivery || null, notes: input.notes || null }, { delivery: input.expectedDelivery, notes: input.notes });
        } else {
          await persistPos(
            [po],
            { supplier: input.supplier, expected_delivery: input.expectedDelivery || null, total_value: value, notes: input.notes || null, vat_enabled: editDraft.vatOn && vat.registered },
            { supplier: input.supplier, delivery: input.expectedDelivery, value, notes: input.notes, vatEnabled: editDraft.vatOn && vat.registered },
          );
        }
        void auditEvent({ action: "UPDATE", entityTable: "purchase_orders", entityId: po.id, newData: { supplier: input.supplier, expected_delivery: input.expectedDelivery, total_value: value } });
        setEditing(null);
        toast.success(`${po.ref} updated`);
      } catch (err) {
        toast.error(userMessage(err, "Could not update the purchase order"));
      }
    });
  }

  async function applyPoAction(action: { po: PurchaseOrderRow; kind: "issue" | "sent" }) {
    await run(async () => {
      try {
        if (action.kind === "issue") {
          await persistPos([action.po], { status: "issued" }, { status: "issued" });
          toast.success(`${action.po.ref} issued: supplier, items and value are now fixed`);
        } else {
          const sentAt = nowIso();
          await persistPos([action.po], { sent_at: sentAt }, { sentAt });
          void auditEvent({ action: "SEND", entityTable: "purchase_orders", entityId: action.po.id, newData: { sent_at: sentAt } });
          toast.success(`${action.po.ref} recorded as sent`);
        }
        setPoAction(null);
      } catch (err) {
        toast.error(userMessage(err, "Could not update the purchase order"));
      }
    });
  }

  function toggleSelected(id: string) {
    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  function printSelected() {
    if (!selectedIds.length) {
      toast.error("Select at least one purchase order to print.");
      return;
    }
    if (!company) {
      toast.error("Company details aren't set up. An admin can add them in Settings.");
      return;
    }
    const selected = purchaseOrders.filter((po) => selectedIds.includes(po.id));
    const opened = openPrintPack(`${company.name} Purchase Order Pack`, selected.map((po) => `<section><h2>${esc(po.ref)}</h2><table><tr><th>Supplier</th><td>${esc(po.supplier)}</td></tr><tr><th>Expected Delivery</th><td>${esc(fmtDate(po.delivery))}</td></tr><tr><th>Value</th><td>${esc(currency(po.value))}</td></tr><tr><th>Status</th><td>${esc(po.status)}</td></tr></table><p><span class="box"></span>Goods received</p><p><span class="box"></span>Quality checked</p></section>`), "purchase_orders");
    if (!opened) {
      toast.error("Allow pop-ups to print.");
      return;
    }
    toast.success(`Preparing ${selected.length} purchase order print pack`);
  }

  async function markReceived(ids: string[]) {
    // Drafts must be issued first; already received ones are skipped.
    const targets = purchaseOrders.filter((po) => ids.includes(po.id) && po.status !== "received" && po.status !== "draft");
    if (!ids.length) {
      toast.error("Select at least one purchase order first.");
      return;
    }
    if (!targets.length) {
      toast.info("Selected purchase orders are already received or still drafts (issue them first).");
      return;
    }
    await run(async () => {
      try {
        const receivedAt = nowIso();
        await persistPos(targets, { status: "received", received_at: receivedAt }, { status: "received", receivedAt });
        // Audit only after the database update succeeded.
        void auditEvent({ action: "MARK_RECEIVED", entityTable: "purchase_orders", metadata: { ids: targets.map((po) => po.id) } });
        setSelectedIds([]);
        setViewing(null);
        setFilters(new Set(["received"]));
        setPhase("done"); // it moved to Done: show it there
        toast.success(`${targets.length} purchase order(s) moved to Received`);
      } catch (err) {
        toast.error(userMessage(err, "Could not mark the purchase order as received"));
      }
    });
  }

  async function downloadPurchaseOrderPdf(po: PurchaseOrderRow) {
    await downloadPdf(async () => {
      const profile = await requireCompanyProfile();
      const saved = (po.items || []).filter((item) => item.description);
      // Real line items when the PO has them, otherwise one line carrying the whole stored value.
      const lineItems = saved.length
        ? saved.map((item) => ({ description: String(item.description), quantity: Number(item.qty || 1), unitPrice: Number(item.unit_price || 0), vatPct: item.vat_pct === undefined ? undefined : Number(item.vat_pct), vatExempt: Boolean(item.vat_exempt) }))
        : [{ description: `Materials ordered from ${po.supplier}`, quantity: 1, unitPrice: po.value }];
      return (
        <PurchaseOrderPDF
          data={{
            number: po.ref,
            date: fmtDate(po.date),
            requiredBy: fmtDate(po.delivery),
            supplier: [po.supplier],
            deliverTo: [profile.documentName, ...profile.addressLines],
            lineItems,
            vatEnabled: Boolean(po.vatEnabled),
            notes: po.notes ? [po.notes] : undefined,
            company: profile,
          }}
        />
      );
    }, `purchase-order-${po.ref}.pdf`, { entityTable: "purchase_orders", entityId: po.ref });
  }

  const editHasItems = Boolean(editing?.items?.some((item) => item.description));

  return (
    <RoleGate allowed={["admin", "office"]}>
      <div className="space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div><h1 className="page-title">Purchase Orders</h1><p className="mt-2 text-sm text-slate-500">Purchase orders are what we buy from suppliers.</p></div>
          <div className="flex flex-wrap items-center gap-2"><ColumnToggle tableKey="purchase-orders" /><ViewSwitcher value={view} onChange={setView} />
          <Dialog open={newOpen} onOpenChange={setNewPoOpen}>
            <DialogTrigger asChild><Button className="min-h-11 bg-brand text-brand-ink hover:bg-brand-hover"><Plus className="size-4" /> New purchase order</Button></DialogTrigger>
            <DialogContent className="max-w-3xl">
              <DialogHeader><DialogTitle>New Purchase Order</DialogTitle><DialogDescription>Add supplier, item, expected delivery and notes. Prices are ex VAT; VAT is added when switched on.</DialogDescription></DialogHeader>
              <form className="grid gap-3" onSubmit={savePo}>
                <select name="supplier" aria-label="Supplier" required className="h-11 rounded-lg border px-3"><option value="">Select supplier...</option>{suppliers.map((supplier) => <option key={supplier} value={supplier}>{supplier}</option>)}</select>
                {supplierPickerHint(suppliers.length, suppliersError) ? (
                  <p role="status" className="-mt-1 flex flex-wrap items-center gap-2 text-sm text-amber-800 dark:text-amber-300">
                    {supplierPickerHint(suppliers.length, suppliersError)}
                    {suppliersError ? <Button type="button" variant="outline" size="sm" onClick={() => void loadSuppliers()}>Retry</Button> : <Link href="/suppliers" className="underline">Open Suppliers</Link>}
                  </p>
                ) : null}
                <div className="grid gap-3 md:grid-cols-3">
                  <Input name="description" maxLength={500} placeholder="Description" required />
                  <Input name="qty" type="number" step="0.001" min="0" inputMode="decimal" placeholder="Qty" value={newQty} onChange={(event) => setNewQty(event.target.value)} required />
                  <Input name="unit_price" type="number" step="0.01" min="0" inputMode="decimal" placeholder="Unit price (ex VAT)" value={newUnit} onChange={(event) => setNewUnit(event.target.value)} required />
                </div>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex flex-wrap items-center gap-4">
                    <VatToggle registered={vat.registered} checked={newPoVat} onChange={setNewVatOn} />
                    {vat.registered ? <VatRateSelect value={newPoChoice} disabled={!newPoVat} onChange={setNewVatChoice} /> : null}
                  </div>
                  <VatTotals totals={documentTotals([{ quantity: Number(newQty) || 0, unitPrice: Number(newUnit) || 0, ...fromVatChoice(newPoChoice) }], 0, { vatEnabled: newPoVat, standardRate: vat.standardRate })} vatEnabled={newPoVat} totalLabel="PO total" className="w-full max-w-xs space-y-1 rounded-lg bg-slate-50 p-4 text-sm" />
                </div>
                <label className="grid gap-1 text-xs text-slate-500">Expected delivery<Input name="expected_delivery" type="date" /></label>
                <Textarea name="notes" maxLength={2000} placeholder="Notes" />
                <Button type="submit" disabled={saving} className="bg-brand text-brand-ink">{saving ? "Saving…" : "Save PO"}</Button>
              </form>
            </DialogContent>
          </Dialog>
          </div>
        </div>
        {DEMO_MODE ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Demo mode: sample data is shown if the database can&apos;t be reached.</div> : null}
        <div className="grid gap-4 md:grid-cols-3">
          {([
            ["Open POs", stats.open, OPEN_STATUSES, ShoppingCart, "text-blue-700 dark:text-blue-400"],
            ["Overdue Delivery", stats.overdue, OPEN_STATUSES, TriangleAlert, "text-red-600 dark:text-red-400"],
            ["Received This Month", stats.receivedMonth, ["received"], CircleCheck, "text-emerald-700 dark:text-emerald-400"],
          ] as const).map(([label, value, filter, Icon, colour]) => (
            <Card key={label} className="cursor-pointer transition hover:bg-muted" onClick={() => setFilters(new Set(filter))}><CardContent className="p-5"><Icon aria-hidden className={`size-5 ${colour}`} /><p className="mt-3 text-sm text-muted-foreground">{label}</p><p className="text-3xl font-bold text-card-foreground">{loading ? "—" : value}</p></CardContent></Card>
          ))}
        </div>
        {listFilter ? <ListFilterNotice label={PO_FILTER_LABELS[listFilter] ?? listFilter} onClear={clearListFilter} /> : null}
      <><PhaseFilter value={phase} onChange={setPhase} counts={phaseCounts} />
        <FilterBar activeValues={[...filters]} options={[{ label: "All", value: "all" }, { label: "Draft", value: "draft" }, { label: "Issued", value: "issued" }, { label: "Sent", value: "sent" }, { label: "Confirmed", value: "confirmed" }, { label: "Awaiting Delivery", value: "awaiting" }, { label: "Received", value: "received" }]} onChange={setFilters} /></>
        <ListToolbar
          visibleCount={visible.length}
          selectedCount={selectedIds.length}
          onSelectAll={() => setSelectedIds(visible.map((po) => po.id))}
          onClear={() => setSelectedIds([])}
          onPrint={printSelected}
          printDisabled={!selectedIds.length}
          printTitle={selectedIds.length ? undefined : "Select at least one purchase order"}
          exports={[
            { label: "CSV", title: scopeTitle, onSelect: () => void exportSpreadsheet("csv", "Purchase Orders", PURCHASE_ORDER_COLUMNS, exportScope, "purchase_orders") },
            { label: "Excel", title: scopeTitle, onSelect: () => void exportSpreadsheet("xlsx", "Purchase Orders", PURCHASE_ORDER_COLUMNS, exportScope, "purchase_orders") },
          ]}
          actions={<Button variant="outline" disabled={saving || !selectedIds.length} title={selectedIds.length ? undefined : "Select at least one purchase order"} onClick={() => void markReceived(selectedIds)}>{saving ? "Saving…" : "Mark Selected Received"}</Button>}
        />
        {loadError ? (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <span>{loadError}</span>
            <Button variant="outline" size="sm" onClick={() => void loadPurchaseOrders()}>Retry</Button>
          </div>
        ) : null}
        {loading ? <div className="space-y-3"><Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" /></div> : loadError && !DEMO_MODE ? null : visible.length === 0 ? (
          <EmptyList
            title={purchaseOrders.length ? "No purchase orders match this filter" : "No purchase orders yet"}
            hint={purchaseOrders.length ? "Try a different filter." : purchaseOrdersEmptyHint()}
            hintTestId={purchaseOrders.length ? undefined : "empty-hint"}
            action={purchaseOrders.length ? <Button variant="outline" onClick={() => setFilters(new Set(["all"]))}>Show all</Button> : <Button className="bg-brand text-brand-ink hover:bg-brand-hover" onClick={() => setNewPoOpen(true)}><Plus className="size-4" /> New purchase order</Button>}
          />
        ) : (
          <Card><CardContent className="p-0"><Table data-view={view}>
            <TableHeader className="hidden md:table-header-group"><TableRow>
              <TableHead><SelectBox aria-label={`Select all ${visible.length} filtered purchase orders`} checked={selectedIds.length === visible.length && visible.length > 0} onChange={(event) => setSelectedIds(event.target.checked ? visible.map((po) => po.id) : [])} /></TableHead>
              {isVisible("ref") ? <TableHead>PO Ref</TableHead> : null}{isVisible("supplier") ? <TableHead>Supplier</TableHead> : null}{isVisible("date") ? <TableHead>Order Date</TableHead> : null}{isVisible("delivery") ? <TableHead>Expected Delivery</TableHead> : null}{isVisible("value") ? <TableHead>{PO_TOTAL_LABEL}</TableHead> : null}{isVisible("status") ? <TableHead>Status</TableHead> : null}<TableHead>Actions</TableHead>
            </TableRow></TableHeader>
            <TableBody>{visible.map((po) => (
              <TableRow key={po.id} className={po.status === "received" ? "block bg-green-50 md:table-row" : "block md:table-row"}>
                <TableCell className="block md:table-cell"><SelectBox aria-label={`Select ${po.ref}`} checked={selectedIds.includes(po.id)} onChange={() => toggleSelected(po.id)} /></TableCell>
                {isVisible("ref") ? <TableCell data-label="PO Ref" className="block font-mono font-semibold md:table-cell">{po.ref}</TableCell> : null}
                {isVisible("supplier") ? <TableCell data-label="Supplier" className="block md:table-cell">{po.supplier}</TableCell> : null}
                {isVisible("date") ? <TableCell data-label="Order Date" className="block md:table-cell">{fmtDate(po.date)}</TableCell> : null}
                {isVisible("delivery") ? <TableCell data-label="Expected Delivery" className="block md:table-cell">{fmtDate(po.delivery)}</TableCell> : null}
                {isVisible("value") ? <TableCell data-label={PO_TOTAL_LABEL} className="block md:table-cell">{currency(purchaseOrderTotalIncVat(po, vat))}</TableCell> : null}
                {isVisible("status") ? <TableCell data-label="Status" className="block md:table-cell"><StatusBadge status={purchaseOrderStatusKey(po.status)} label={po.status} className="capitalize" /></TableCell> : null}
                <TableCell data-actions className="block md:table-cell"><div className="flex flex-wrap items-center gap-2">
                  <div className="flex shrink-0 items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => setViewing(po)}>View</Button>
                    {archive.canManage ? <ArchiveButton id={po.id ? String(po.id) : undefined} phase={phaseFor(po)} manual={po.id ? archive.manual.get(String(po.id)) : undefined} onSet={archive.setState} /> : null}
                  </div>
                  <Button variant="outline" size="sm" onClick={() => startEdit(po)}>Edit</Button>
                  {po.status === "draft" ? <Button size="sm" disabled={saving} className="bg-brand text-brand-ink" onClick={() => setPoAction({ po, kind: "issue" })}>Issue</Button> : null}
                  {po.status !== "draft" && !po.sentAt && po.status !== "received" ? <Button variant="outline" size="sm" disabled={saving} onClick={() => setPoAction({ po, kind: "sent" })}>Record Sent</Button> : null}
                  <Button variant="outline" size="sm" disabled={saving || po.status === "received" || po.status === "draft"} onClick={() => void markReceived([po.id])}>Mark Received</Button>
                  <Button asChild size="sm" className="bg-brand text-brand-ink"><Link href={`/purchase-orders/${encodeURIComponent(po.id)}/print`}>Print PO</Link></Button>
                </div></TableCell>
              </TableRow>
            ))}</TableBody>
          </Table></CardContent></Card>
        )}
        <Dialog open={Boolean(viewing)} onOpenChange={(open) => !open && setViewing(null)}><DialogContent><DialogHeader><DialogTitle>{viewing?.ref}</DialogTitle><DialogDescription>Purchase order detail</DialogDescription></DialogHeader>{viewing ? <div className="space-y-3 text-sm"><p><strong>Supplier:</strong> {viewing.supplier}</p><p><strong>Order date:</strong> {fmtDate(viewing.date)}</p><p><strong>Expected delivery:</strong> {fmtDate(viewing.delivery) || "Not set"}</p><p><strong>Value:</strong> {currency(viewing.value)}</p><p><strong>Status:</strong> {viewing.status}</p>{viewing.receivedAt ? <p><strong>Received:</strong> {fmtDate(viewing.receivedAt)}</p> : null}{viewing.notes ? <p><strong>Notes:</strong> {viewing.notes}</p> : null}<div className="flex flex-wrap gap-2"><Button onClick={() => window.open(`/purchase-orders/${encodeURIComponent(viewing.id)}/print`, "_blank")} className="bg-brand text-brand-ink">Print</Button><Button variant="outline" onClick={() => void downloadPurchaseOrderPdf(viewing)}>Download PDF</Button></div>{viewing.id.startsWith("demo-") ? null : <DocumentAttachments parent={{ kind: "purchase_order", id: viewing.id }} canRemove />}</div> : null}<ActivityPanel table="purchase_orders" recordId={viewing?.id} className="mt-4" /></DialogContent></Dialog>
        <Dialog open={Boolean(poAction)} onOpenChange={(open) => !open && setPoAction(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{poAction?.kind === "issue" ? `Issue ${poAction?.po.ref}?` : `Has ${poAction?.po.ref} gone to the supplier?`}</DialogTitle>
              <DialogDescription>{poAction?.kind === "issue" ? "Issuing fixes the supplier, items and value. The delivery date and notes can still change." : "Only confirm once it has actually been sent. This records the time."}</DialogDescription>
            </DialogHeader>
            {issueNotice ? (
              <p role="status" data-testid="supplier-order-notice" className={issueNotice.tone === "blocked" ? "text-sm font-medium text-red-700 dark:text-red-300" : "text-sm font-medium text-amber-800 dark:text-amber-300"}>
                {issueNotice.text}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setPoAction(null)}>{poAction?.kind === "issue" ? "Cancel" : "Not yet"}</Button>
              <Button className="bg-brand text-brand-ink" disabled={saving || issueNotice?.tone === "blocked"} onClick={() => poAction && void applyPoAction(poAction)}>{poAction?.kind === "issue" ? "Issue Purchase Order" : "I\u2019ve sent it"}</Button>
            </div>
          </DialogContent>
        </Dialog>
        <Dialog open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Edit {editing?.ref}</DialogTitle><DialogDescription>Update supplier order details.</DialogDescription></DialogHeader>
            {editing ? (
              <div className="grid gap-3">
                {editing.status !== "draft" ? <p className="text-sm text-slate-600">Issued: the supplier, items and value are fixed. You can still change the delivery date and notes.</p> : null}
                <select value={editDraft.supplier} disabled={editing.status !== "draft"} className="h-11 rounded-lg border px-3" onChange={(event) => setEditDraft((draft) => ({ ...draft, supplier: event.target.value }))}>{(suppliers.includes(editing.supplier) ? suppliers : [editing.supplier, ...suppliers]).map((supplier) => <option key={supplier} value={supplier}>{supplier}</option>)}</select>
                <label className="grid gap-1 text-xs text-slate-500">Expected delivery<Input type="date" value={editDraft.delivery} onChange={(event) => setEditDraft((draft) => ({ ...draft, delivery: event.target.value }))} /></label>
                <label className="grid gap-1 text-xs text-slate-500">Order value (ex VAT){editHasItems ? " - set by the line items" : ""}<Input type="number" step="0.01" min="0" inputMode="decimal" disabled={editHasItems || editing.status !== "draft"} value={editDraft.value} onChange={(event) => setEditDraft((draft) => ({ ...draft, value: event.target.value }))} /></label>
                {editing.status === "draft" ? <VatToggle registered={vat.registered} checked={editDraft.vatOn && vat.registered} onChange={(checked) => setEditDraft((draft) => ({ ...draft, vatOn: checked }))} /> : null}
                <Textarea placeholder="Notes" maxLength={2000} value={editDraft.notes} onChange={(event) => setEditDraft((draft) => ({ ...draft, notes: event.target.value }))} />
                <Button disabled={saving} onClick={() => void saveEdit()} className="bg-brand text-brand-ink">{saving ? "Saving…" : "Save Changes"}</Button>
              </div>
            ) : null}
          </DialogContent>
        </Dialog>
      </div>
    </RoleGate>
  );
}
