"use client";

import { ActivityPanel } from "@/components/activity-panel";
import { EmptyList } from "@/components/empty-list";
import { salesOrdersEmptyHint } from "@/lib/empty-hints";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ClipboardList, Plus } from "lucide-react";

import { FilterBar } from "@/components/filter-bar";
import { ArchiveButton, PhaseFilter } from "@/components/phase-filter";
import { phaseOf, type PhaseFilterValue, useArchive } from "@/lib/archive";
import { ColumnToggle } from "@/components/column-toggle";
import { ListToolbar } from "@/components/list-toolbar";
import { ViewSwitcher } from "@/components/view-switcher";
import { useViewMode } from "@/lib/view-mode";
import { RoleGate } from "@/components/role-gate";
import { StatusBadge } from "@/components/status-badge";
import { salesOrderStatusKey } from "@/lib/status-colours";
import { Button } from "@/components/ui/button";
import { SelectBox } from "@/components/ui/select-box";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { CustomerSelect } from "@/components/customer-select";
import { SoMachinesDialog } from "@/components/so-machines-dialog";
import { type OrderPlanRow, describeMachines, sumMachineHours, totalHours } from "@/lib/so-machines";
import { ukDateTime } from "@/lib/auto-booking";
import { canDespatch, editBlockedReason, isConverted, ordersToConvert, ordersToDespatch } from "@/lib/sales-order-convert";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { SalesOrderPDF } from "@/components/pdf/SalesOrderPDF";
import { auditEvent } from "@/lib/audit";
import { requireCompanyProfile, useCompanyProfile } from "@/lib/company";
import { resolveCustomerAddress } from "@/lib/customers";
import { DEMO_MODE } from "@/lib/demo";
import { fmtDate, toDateInput } from "@/lib/dates";
import { downloadPdf } from "@/lib/download-pdf";
import { friendlyError } from "@/lib/friendly-error";
import { esc } from "@/lib/html";
import { documentTotals, gbp } from "@/lib/money";
import { countPhases, SALES_ORDER_OPEN_CARD_NOTE, SALES_ORDER_OPEN_CARD_STATUSES, salesOrderCardCounts } from "@/lib/list-card-counts";
import { allocateNumber } from "@/lib/numbering";
import { orderTermsFromQuote, type QuoteLineRow } from "@/lib/order-from-quote";
import { databaseHas068 } from "@/lib/db-features";
import { openPrintPack } from "@/lib/print-pack";
import { exportSpreadsheet } from "@/lib/export-records";
import { SALES_ORDER_COLUMNS } from "@/lib/import-columns";
import { exportScopeTitle } from "@/lib/spreadsheet";
import { useColumnVisibility } from "@/lib/org-settings";
import { supabase } from "@/lib/supabase";
import { getCurrentOrganizationId } from "@/lib/supabase-business";
import { useSaving } from "@/lib/use-saving";
import { ValidationError, parseOrThrow, salesOrderSaveSchema, userMessage } from "@/lib/validation/schemas";
import { companyVat, fromVatChoice, toVatChoice, type VatChoice } from "@/lib/vat";
import { VatRateSelect, VatToggle } from "@/components/vat-controls";
import { VatTotals } from "@/components/vat-totals";
import { fetchAll, truncationNotice } from "@/lib/fetch-all";
import { type AcceptQuoteResult, awaitsCustomerPo, customerPoInput, manualOrderIdentity } from "@/lib/accept-quote";
import { jobHref } from "@/lib/job-link";

type SalesOrder = {
  /** Database UUID. Missing on demo rows. */
  id?: string;
  /** The customer's own purchase order number. */
  ref: string;
  customer: string;
  /** ISO order date (YYYY-MM-DD). */
  date: string;
  /** ISO delivery date (YYYY-MM-DD) or "". */
  delivery: string;
  /** Order value, ex VAT. */
  value: number;
  /** "Add VAT" on this order and the order's VAT rate (orders created before the VAT options: off). */
  vatEnabled: boolean;
  vat: VatChoice;
  status: string;
  /** Job number (J-####) of the job this order was converted to. */
  convertedJob: string;
  /** Linked quote (UUID in Supabase) and its QUO-#### number, used to give the job the quote's number. */
  quoteId?: string;
  quoteRef?: string;
  /** The customer's PO. Empty on an order made from an accepted quote before the PO arrived (its ref is a provisional SO-####). */
  customerPo?: string;
};

type AcceptedQuote = { id: string; ref: string; customer: string; total: number };

const currency = (value: number) => gbp(value, 2);

/** Demo mode only. JNR's real records are imported lazily so they never ship in the production bundle. */
async function loadDemoOrders(): Promise<SalesOrder[]> {
  const m = await import("@/lib/jnr-test-data");
  return m.JNR_TEST_SALES_ORDERS.map((order): SalesOrder => ({ ref: order.ref, customer: order.customer, date: order.orderDate, delivery: order.dueDate, value: order.value, vatEnabled: false, vat: "20", status: order.status, convertedJob: order.jobNo, quoteRef: order.quoteRef }));
}

const emptyForm: { quoteId: string; customer: string; customerPo: string; orderDate: string; deliveryDate: string; value: string; notes: string; vatOn: boolean | null; vat: VatChoice | null } = { quoteId: "", customer: "", customerPo: "", orderDate: "", deliveryDate: "", value: "", notes: "", vatOn: null, vat: null };

export default function SalesOrdersPage() {
  const { isVisible } = useColumnVisibility("sales-orders");
  // Cards / List / Table, remembered per person (lib/view-mode; styles in app/globals.css [data-view]).
  const [view, setView] = useViewMode("sales-orders", "table");
  const { profile: company } = useCompanyProfile();
  const vat = companyVat(company);
  const router = useRouter();
  const { saving, run } = useSaving();
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filters, setFilters] = useState(new Set(["all"]));
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [selected, setSelected] = useState<SalesOrder | null>(null);
  const [editing, setEditing] = useState<SalesOrder | null>(null);
  const [editDraft, setEditDraft] = useState<{ customer: string; delivery: string; value: string; vatOn: boolean; vat: VatChoice }>({ customer: "", delivery: "", value: "", vatOn: false, vat: "20" });
  const [newOpen, setNewOpen] = useState(false);
  const [form, setForm] = useState({ ...emptyForm, orderDate: toDateInput(new Date()) });
  const [quoteLink, setQuoteLink] = useState<{ state: "none" | "loading" | "ready" | "error"; quoteId?: string; message?: string }>({ state: "none" });
  // New order: VAT follows the company settings until changed on the form.
  const formVatOn = vat.registered && (form.vatOn ?? true);
  const formVatChoice = form.vat ?? vat.defaultChoice;
  const [acceptedQuotes, setAcceptedQuotes] = useState<AcceptedQuote[]>([]);
  // The machines planned on each order's lines (migration 043): "Mill 6 h, Lathe 2.5 h" per order, edited in a dialog.
  const [machinesOrder, setMachinesOrder] = useState<SalesOrder | null>(null);
  const [planByOrder, setPlanByOrder] = useState<Map<string, string>>(new Map());
  const [quotesError, setQuotesError] = useState<string | null>(null);
  // "Add customer PO" (migration 058): the order, and what is typed.
  const [poOrder, setPoOrder] = useState<SalesOrder | null>(null);
  const [poDraft, setPoDraft] = useState("");

  const keyOf = (order: SalesOrder) => order.id ?? order.ref;
  // Open / Done / Archived (lib/archive, migration 028): finished records move out of the way; nothing is deleted.
  const archive = useArchive("sales_orders");
  const [phase, setPhase] = useState<PhaseFilterValue>("open");
  // An order waiting for its customer PO (058: accepted with none, so converted at once when the setting is automatic) stays Open
  // until the PO is added: that is still to do here.
  const phaseFor = useCallback((order: (typeof orders)[number]) => phaseOf({ final: ["despatched", "converted", "closed"].includes(order.status) && !awaitsCustomerPo(order), finalDate: order.delivery || order.date }, order.id ? archive.manual.get(String(order.id)) : undefined, archive.months), [archive.manual, archive.months]);
  const phaseCounts = useMemo(() => countPhases(orders, phaseFor), [orders, phaseFor]);
  const visible = useMemo(() => orders.filter((order) => (phase === "all" || phaseFor(order) === phase) && (filters.has("all") || filters.has(order.status))), [filters, orders, phase, phaseFor]);
  // The Open card is the Open tab's count without Converted orders (they are already jobs); its click shows exactly those.
  const counts = useMemo(() => salesOrderCardCounts(orders, phaseFor), [orders, phaseFor]);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      if (!supabase) throw new Error("Supabase is not configured.");
      // Every row, page by page (lib/fetch-all): the API returns at most 1,000 per request.
        const { rows: data, truncated } = await fetchAll((from, to) => supabase!.from("sales_orders").select("*").order("order_date", { ascending: false }).order("id").range(from, to));
        const error = null;
        if (truncated) toast.warning(truncationNotice(data.length));
      if (error) throw error;
      const rows = data ?? [];
      // Show the job number (J-####) of converted orders rather than the job's UUID.
      const jobIds = [...new Set(rows.map((row) => row.converted_to_job_id).filter(Boolean).map(String))];
      const jobNumbers = new Map<string, string>();
      if (jobIds.length) {
        const { data: jobs, error: jobsError } = await supabase.from("jobs").select("id, job_no").in("id", jobIds);
        if (jobsError) console.error(jobsError);
        for (const job of jobs ?? []) jobNumbers.set(String(job.id), String(job.job_no || ""));
      }
      void loadPlans().then((map) => { if (map) setPlanByOrder(map); });
      // Trust the database, including an empty result.
      setOrders(rows.map((row): SalesOrder => ({
        id: String(row.id),
        ref: row.customer_po || row.so_number || row.order_ref || `SO-${String(row.id).slice(0, 8)}`,
        customer: row.customer || row.customer_name || "",
        date: row.order_date ? String(row.order_date).slice(0, 10) : row.created_at ? toDateInput(String(row.created_at)) : "",
        delivery: row.delivery_date ? String(row.delivery_date).slice(0, 10) : row.expected_delivery ? String(row.expected_delivery).slice(0, 10) : "",
        value: Number(row.total_value || 0),
        vatEnabled: row.vat_enabled === true,
        vat: toVatChoice(row.vat_pct, row.vat_exempt),
        status: row.status || "open",
        convertedJob: row.converted_to_job_id ? (jobNumbers.get(String(row.converted_to_job_id)) || "Linked") : "",
        quoteId: row.quote_id || undefined,
        quoteRef: row.quote_ref || undefined,
        customerPo: row.customer_po ? String(row.customer_po) : "",
      })));
    } catch (err) {
      setLoadError(friendlyError(err, "Couldn't load sales orders."));
      setOrders(DEMO_MODE ? await loadDemoOrders() : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadOrders(); }, [loadOrders]);

  /** Every order's machine plan in one request, summed per machine as the job will hold it; null when it can't be read. */
  async function loadPlans(): Promise<Map<string, string> | null> {
    if (!supabase) return null;
    const { data, error } = await supabase.from("sales_order_line_machines").select("sales_order_id, machine_id, estimated_hours, line_key, sales_order_line_id, position, machines(name)");
    if (error) { console.error(error); return null; }
    const names = new Map<string, string>();
    const rowsByOrder = new Map<string, OrderPlanRow[]>();
    for (const row of data ?? []) {
      const machine = row.machines as unknown as { name?: string } | { name?: string }[] | null;
      names.set(String(row.machine_id), String((Array.isArray(machine) ? machine[0]?.name : machine?.name) ?? "Machine"));
      const key = String(row.sales_order_id);
      rowsByOrder.set(key, [...(rowsByOrder.get(key) ?? []), { machine_id: String(row.machine_id), estimated_hours: Number(row.estimated_hours), line_key: Number(row.line_key), sales_order_line_id: row.sales_order_line_id ? String(row.sales_order_line_id) : null, position: Number(row.position) }]);
    }
    return new Map([...rowsByOrder].map(([id, rows]) => [id, describeMachines(sumMachineHours(rows).map((m) => ({ name: names.get(m.machine_id) ?? "Machine", hours: m.hours })))]));
  }

  // Accepted quotes for the New Sales Order picker.
  useEffect(() => {
    if (!newOpen || !supabase) return;
    let cancelled = false;
    setQuotesError(null);
    supabase.from("quotes").select("id, quote_ref, customer, total_value").eq("status", "accepted").order("created_at", { ascending: false }).limit(200)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) { console.error(error); setQuotesError("Couldn't load accepted quotes. You can still enter the order by hand."); return; }
        setAcceptedQuotes((data ?? []).map((row) => ({ id: String(row.id), ref: String(row.quote_ref || ""), customer: String(row.customer || ""), total: Number(row.total_value || 0) })));
      });
    return () => { cancelled = true; };
  }, [newOpen]);

  /**
   * Linking an accepted quote (audit R2, R3): the previous quote's value and VAT are cleared at once, and a linked
   * order can't be saved until this quote's lines have loaded. Value (net) and VAT setting come from the quote when
   * one order can hold them exactly; otherwise linking is refused (lib/order-from-quote). No quote: entered by hand.
   */
  async function pickQuote(quoteId: string) {
    const quote = acceptedQuotes.find((item) => item.id === quoteId);
    setForm((current) => ({ ...current, quoteId, customer: quote?.customer ?? current.customer, ...(quoteId !== current.quoteId ? { value: "", vatOn: null, vat: null } : {}) }));
    if (!quoteId) return setQuoteLink({ state: "none" });
    setQuoteLink({ state: "loading", quoteId });
    const fail = (message: string) => setQuoteLink((current) => (current.quoteId === quoteId ? { state: "error", quoteId, message } : current));
    if (!quote || !supabase) return fail("Couldn't load that quote. Choose it again or enter the order by hand.");
    // declined (068): lines the customer's PO didn't cover; before 068 there is no such column and every line is ordered.
    const lineColumns: string = `quantity, unit_price, vat_pct, vat_exempt${await databaseHas068() ? ", declined" : ""}`;
    const [{ data: head, error: headError }, { data: lines, error: linesError }] = await Promise.all([
      supabase.from("quotes").select("vat_enabled, total_value").eq("id", quote.id).maybeSingle(),
      supabase.from("quote_line_items").select(lineColumns).eq("quote_id", quote.id),
    ]);
    if (headError || linesError || !head) return fail("Couldn't load that quote's lines. Choose it again, or choose \"No linked quote\" and enter the order by hand.");
    const terms = orderTermsFromQuote(head, (lines ?? []) as unknown as QuoteLineRow[], vat.registered);
    if (!terms.ok) return fail(terms.reason);
    setForm((current) => (current.quoteId === quoteId ? { ...current, value: String(terms.value), vatOn: terms.vatOn, vat: terms.vat } : current));
    setQuoteLink((current) => (current.quoteId === quoteId ? { state: "ready", quoteId } : current));
  }

  async function createOrder(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(async () => {
      try {
        if (!supabase) throw new Error("Supabase is not configured.");
        const quote = acceptedQuotes.find((item) => item.id === form.quoteId);
        if (form.quoteId && (quoteLink.quoteId !== form.quoteId || quoteLink.state !== "ready")) {
          throw new ValidationError(quoteLink.state === "error" && quoteLink.message ? quoteLink.message : "Wait for the quote's lines to load before saving.");
        }
        const input = parseOrThrow(salesOrderSaveSchema, {
          customer: form.customer,
          customerPo: form.customerPo,
          quoteRef: quote?.ref ?? "",
          orderDate: form.orderDate,
          deliveryDate: form.deliveryDate,
          totalValue: form.value.trim() === "" ? Number.NaN : Number(form.value),
        });
        if (quote) {
          // From an accepted quote: the one path that makes a quote's order (accept_quote, migration 058). The database works out the
          // same value and VAT shown here, keeps one order per quote (an order it already has is returned), and makes its job when the
          // company's setting is automatic.
          const { data, error } = await supabase.rpc("accept_quote", { p_quote: quote.id, p_customer_po: customerPoInput(input.customerPo), p_delivery_date: input.deliveryDate || null });
          if (error) throw error;
          const result = data as AcceptQuoteResult;
          if (!result.so_id) throw new ValidationError(result.reason ?? "No sales order could be made from that quote. Choose \"No linked quote\" and enter the order by hand.");
          if (result.so_created) {
            // What the order form adds to what the quote gives: the order date when it isn't today, and the notes.
            const extra: Record<string, unknown> = {};
            if (input.orderDate !== toDateInput(new Date())) extra.order_date = input.orderDate;
            if (form.notes.trim()) extra.notes = form.notes.trim();
            if (Object.keys(extra).length) {
              const { error: extraError } = await supabase.from("sales_orders").update(extra).eq("id", result.so_id);
              if (extraError) toast.error(`Sales order ${result.so_number} was created, but its ${Object.keys(extra).map((key) => key.replace("_", " ")).join(" and ")} weren't saved. Edit the order to add them.`);
            }
            toast.success(result.job_no ? `Sales order ${result.so_number} created and job ${result.job_no} made, not started` : `Sales order ${result.so_number} created`);
            if (result.job_reason) toast.warning(result.job_reason);
          } else {
            toast.info(`${quote.ref} already has sales order ${result.so_number}${result.job_no ? ` (job ${result.job_no})` : ""}. Nothing new was made.`);
          }
          setForm({ ...emptyForm, orderDate: toDateInput(new Date()) });
          setQuoteLink({ state: "none" });
          setNewOpen(false);
          void loadOrders();
          return;
        }
        const organizationId = await getCurrentOrganizationId();
        // The order is referenced by the customer's own PO number; with none yet, a provisional SO-#### number (the PO is added later).
        const identity = await manualOrderIdentity(input.customerPo, () => allocateNumber("SO"));
        const { error } = await supabase.from("sales_orders").insert({
          organization_id: organizationId,
          so_number: identity.soNumber,
          customer_po: identity.customerPo,
          customer: input.customer,
          // No linked quote (an order from a quote is made by accept_quote above).
          quote_id: null,
          quote_ref: null,
          order_date: input.orderDate,
          delivery_date: input.deliveryDate || null,
          total_value: input.totalValue,
          vat_enabled: formVatOn,
          vat_pct: fromVatChoice(formVatChoice).vatPct,
          vat_exempt: fromVatChoice(formVatChoice).vatExempt,
          status: "open",
          notes: form.notes.trim() || null,
        });
        if (error) throw error;
        void auditEvent({ action: "CREATE", entityTable: "sales_orders", entityId: identity.soNumber });
        toast.success(`Sales order ${identity.soNumber} created${identity.customerPo ? "" : ". Add the customer PO when it arrives."}`);
        // Reset and close only after a successful save.
        setForm({ ...emptyForm, orderDate: toDateInput(new Date()) });
        setQuoteLink({ state: "none" });
        setNewOpen(false);
        void loadOrders();
      } catch (err) {
        toast.error(userMessage(err, "Could not create the sales order. Nothing was saved."));
      }
    });
  }

  /** Writes columns to the given orders, then mirrors them on screen. Throws on failure. */
  async function persistOrders(targets: SalesOrder[], columns: Record<string, unknown>, patch: Partial<SalesOrder>) {
    const real = targets.filter((order) => order.id);
    if (real.length) {
      if (!supabase) throw new Error("Supabase is not configured.");
      const { error } = await supabase.from("sales_orders").update(columns).in("id", real.map((order) => order.id as string));
      if (error) throw error;
    } else if (targets.length && !DEMO_MODE) {
      throw new Error("Supabase is not configured.");
    }
    const keys = targets.map(keyOf);
    setOrders((current) => current.map((order) => keys.includes(keyOf(order)) ? { ...order, ...patch } : order));
  }

  /**
   * The customer's PO, once it arrives (set_sales_order_customer_po, migration 058): the order's reference follows it when it was
   * provisional, and its unfinished job's worksheet gets the same PO.
   */
  async function saveCustomerPo() {
    const order = poOrder;
    if (!order?.id) return;
    await run(async () => {
      try {
        const po = customerPoInput(poDraft);
        if (!po) throw new ValidationError("Enter the customer's order number");
        if (!supabase) throw new Error("Supabase is not configured.");
        const { data, error } = await supabase.rpc("set_sales_order_customer_po", { p_order: order.id, p_customer_po: po });
        if (error) throw error;
        const result = data as { so_number: string; customer_po: string; job_no: string | null; job_updated: boolean };
        setOrders((current) => current.map((item) => keyOf(item) === keyOf(order) ? { ...item, ref: result.so_number, customerPo: result.customer_po } : item));
        setSelected((current) => current && keyOf(current) === keyOf(order) ? { ...current, ref: result.so_number, customerPo: result.customer_po } : current);
        setPoOrder(null);
        setPoDraft("");
        // With its PO, a converted order is finished: it moves to Done, so show it there (as Despatch does).
        const moved = phaseFor({ ...order, ref: result.so_number, customerPo: result.customer_po });
        if (phase !== "all" && moved !== phase) setPhase(moved);
        toast.success(`Customer PO ${result.customer_po} added${result.job_updated && result.job_no ? `; job ${result.job_no} has it too` : result.job_no ? `; job ${result.job_no} is finished and keeps the PO it was made with` : ""}`);
      } catch (err) {
        toast.error(userMessage(err, "Could not save the customer PO"));
      }
    });
  }

  function startEdit(order: SalesOrder) {
    // A converted order's value and VAT are its job's (088): Edit is disabled for it; this stops any other way in.
    const blocked = editBlockedReason(order);
    if (blocked) {
      toast.error(blocked);
      return;
    }
    setEditDraft({ customer: order.customer, delivery: toDateInput(order.delivery), value: String(order.value), vatOn: order.vatEnabled && vat.registered, vat: order.vat });
    setEditing(order);
  }

  async function saveEdit() {
    const order = editing;
    if (!order) return;
    // Refused before anything is written: the order may have been converted since the dialog opened (the database refuses too, 088).
    const blocked = editBlockedReason(orders.find((item) => keyOf(item) === keyOf(order)) ?? order);
    if (blocked) {
      toast.error(blocked);
      setEditing(null);
      return;
    }
    await run(async () => {
      try {
        const input = parseOrThrow(salesOrderSaveSchema, {
          customer: editDraft.customer,
          customerPo: order.ref,
          quoteRef: "",
          orderDate: order.date || toDateInput(new Date()),
          deliveryDate: editDraft.delivery,
          totalValue: editDraft.value.trim() === "" ? Number.NaN : Number(editDraft.value),
        });
        await persistOrders(
          [order],
          { customer: input.customer, delivery_date: input.deliveryDate || null, total_value: input.totalValue,
            vat_enabled: editDraft.vatOn && vat.registered, vat_pct: fromVatChoice(editDraft.vat).vatPct, vat_exempt: fromVatChoice(editDraft.vat).vatExempt },
          { customer: input.customer, delivery: input.deliveryDate, value: input.totalValue, vatEnabled: editDraft.vatOn && vat.registered, vat: editDraft.vat },
        );
        void auditEvent({ action: "UPDATE", entityTable: "sales_orders", entityId: order.id ?? order.ref, newData: { customer: input.customer, delivery_date: input.deliveryDate, total_value: input.totalValue } });
        setEditing(null);
        toast.success(`${order.ref} updated`);
      } catch (err) {
        toast.error(userMessage(err, "Could not update the sales order"));
      }
    });
  }

  /**
   * Converts one order to its job in a single database transaction (convert_sales_order): exactly one job per order;
   * an order that already has a job gets that job back, whatever its status. Throws on failure.
   */
  async function convertOne(order: SalesOrder): Promise<{ jobId: string; jobNo: string; created: boolean; carried: string }> {
    if (!supabase || !order.id) throw new ValidationError("This sales order must be saved in the database before it can be converted.");
    const { data, error } = await supabase.rpc("convert_sales_order", { p_order: order.id });
    if (error) throw error;
    const result = data as { job_id: string; job_no: string; created: boolean };
    // The machines planned on the order's lines, now on the job (043): "carried 2 machines (7.5 h)", read from the job's plan.
    let carried = "";
    if (result.created) {
      const { data: links } = await supabase.from("job_machines").select("estimated_hours, booking_id").eq("job_id", result.job_id);
      if (links?.length) carried = `; carried ${links.length} machine${links.length === 1 ? "" : "s"} (${totalHours(links.map((l) => ({ hours: Number(l.estimated_hours) })))} h)`;
      // 061: each carried machine is booked at its next free slot. A database before 061 books none (nothing is added then).
      const bookingIds = (links ?? []).map((l) => l.booking_id as string | null).filter((id): id is string => Boolean(id));
      if (bookingIds.length) {
        const { data: booked } = await supabase.from("machine_bookings").select("start_at").in("id", bookingIds).order("start_at").limit(1);
        if (booked?.[0]?.start_at) carried += `; booked on the schedule from ${ukDateTime(String(booked[0].start_at))}`;
      }
    }
    setOrders((current) => current.map((item) => keyOf(item) === keyOf(order)
      ? { ...item, status: result.created ? "converted" : item.status, convertedJob: result.job_no || "Linked" }
      : item));
    if (result.created) void auditEvent({ action: "CONVERT_TO_JOB", entityTable: "sales_orders", entityId: order.id, newData: { order: order.ref, job: result.job_no } });
    return { jobId: result.job_id, jobNo: result.job_no, created: result.created, carried };
  }

  async function convertOrders(targets: SalesOrder[]) {
    if (!targets.length) {
      toast.error("Select at least one sales order first.");
      return;
    }
    await run(async () => {
      let lastJob = "";
      let lastJobId = "";
      // One at a time so each job gets its own number.
      for (const order of targets) {
        try {
          const result = await convertOne(order);
          lastJob = result.jobNo;
          lastJobId = result.jobId;
          if (result.created) toast.success(`Job ${lastJob} created from sales order ${order.ref}${result.carried}`);
          else toast.info(`${order.ref} was already converted to job ${lastJob}`);
        } catch (err) {
          toast.error(`${order.ref}: ${userMessage(err, "Could not convert this sales order.")}`);
        }
      }
      if (lastJob) {
        setSelectedKeys([]);
        setSelected(null);
        router.push(jobHref({ id: lastJobId, job_no: lastJob }));
      }
    });
  }

  function toggleSelected(order: SalesOrder) {
    const key = keyOf(order);
    setSelectedKeys((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  }

  async function despatchOrders(targets: SalesOrder[]) {
    if (!targets.length) {
      toast.error("Select at least one sales order first.");
      return;
    }
    await run(async () => {
      try {
        await persistOrders(targets, { status: "despatched" }, { status: "despatched" });
        void auditEvent({ action: "DESPATCH", entityTable: "sales_orders", metadata: { refs: targets.map((order) => order.ref) } });
        setSelectedKeys([]);
        setSelected(null);
        setFilters(new Set(["despatched"]));
        setPhase("done"); // it moved to Done: show it there
        toast.success(`${targets.length} sales order(s) moved to Despatched`);
      } catch (err) {
        toast.error(userMessage(err, "Could not despatch sales order"));
      }
    });
  }

  const selectedOrders = orders.filter((order) => selectedKeys.includes(keyOf(order)));
  // CSV / Excel: the selected orders if any, otherwise every order in the current filter; the import column spec.
  const exportScope = selectedOrders.length ? selectedOrders : visible;
  const scopeTitle = exportScopeTitle("sales order", selectedOrders.length, visible.length);

  function printSelected() {
    if (!selectedOrders.length) {
      toast.error("Select at least one sales order to print.");
      return;
    }
    if (!company) {
      toast.error("Company details aren't set up. An admin can add them in Settings.");
      return;
    }
    const opened = openPrintPack(`${company.name} Sales Order Pack`, selectedOrders.map((order) => `<section><h2>${esc(order.ref)}</h2><table><tr><th>Customer</th><td>${esc(order.customer)}</td></tr><tr><th>Order Date</th><td>${esc(fmtDate(order.date))}</td></tr><tr><th>Delivery</th><td>${esc(fmtDate(order.delivery))}</td></tr><tr><th>Value</th><td>${esc(currency(order.value))}</td></tr><tr><th>Status</th><td>${esc(order.status)}</td></tr></table></section>`), "sales_orders");
    if (!opened) {
      toast.error("Allow pop-ups to print.");
      return;
    }
    toast.success(`Preparing ${selectedOrders.length} sales order print pack`);
  }

  async function downloadSalesOrderPdf(order: SalesOrder) {
    await downloadPdf(async () => {
      const profile = await requireCompanyProfile();
      const billTo = await resolveCustomerAddress(order.customer);
      return (
        <SalesOrderPDF
          data={{
            number: order.ref,
            date: fmtDate(order.date),
            deliveryDate: fmtDate(order.delivery),
            quoteRef: order.quoteRef,
            billTo,
            lineItems: [{ description: `Customer order ${order.ref}`, quantity: 1, unitPrice: order.value, ...fromVatChoice(order.vat) }],
            vatEnabled: order.vatEnabled,
            company: profile,
          }}
        />
      );
    }, `sales-order-${order.ref}.pdf`, { entityTable: "sales_orders", entityId: order.ref });
  }

  return (
    <RoleGate allowed={["admin", "office"]}>
      <div className="space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div><h1 className="page-title">Sales Orders</h1><p className="mt-2 text-sm text-slate-500">A sales order is a customer&apos;s confirmed order. Turn it into a job when work starts.</p></div>
          <div className="flex flex-wrap items-center gap-2"><ColumnToggle tableKey="sales-orders" /><ViewSwitcher value={view} onChange={setView} />
          <Dialog open={newOpen} onOpenChange={setNewOpen}>
            <DialogTrigger asChild><Button className="min-h-11 bg-brand text-brand-ink hover:bg-brand-hover"><Plus className="size-4" /> New sales order</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>New Sales Order</DialogTitle><DialogDescription>Create from an accepted quote, or enter the customer&apos;s order by hand.</DialogDescription></DialogHeader>
              <form onSubmit={createOrder} className="grid gap-3">
                <label className="grid gap-1 text-xs text-slate-500">Accepted quote (optional)
                  <select value={form.quoteId} onChange={(event) => void pickQuote(event.target.value)} className="h-11 rounded-lg border px-3 text-sm text-slate-950">
                    <option value="">{acceptedQuotes.length ? "No linked quote" : "No accepted quotes"}</option>
                    {acceptedQuotes.map((quote) => <option key={quote.id} value={quote.id}>{quote.ref} - {quote.customer}</option>)}
                  </select>
                </label>
                {quotesError ? <p className="text-sm text-amber-700">{quotesError}</p> : null}
                {form.quoteId && quoteLink.state === "loading" ? <p className="text-sm text-slate-500" role="status">Loading the quote&apos;s lines...</p> : null}
                {form.quoteId && quoteLink.state === "error" ? <p className="text-sm text-red-700" role="alert">{quoteLink.message}</p> : null}
                <CustomerSelect name="customer" required value={form.customer} onValueChange={(customer) => setForm((current) => ({ ...current, customer }))} />
                <label className="grid gap-1 text-xs text-slate-500">Customer PO (optional)
                  <Input placeholder="Customer order number (their PO)" maxLength={100} value={form.customerPo} onChange={(event) => setForm((current) => ({ ...current, customerPo: event.target.value }))} />
                  <span>Not received yet? Leave it empty: the order gets a provisional number and you add the PO later.</span>
                </label>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="grid gap-1 text-xs text-slate-500">Order date<Input type="date" required value={form.orderDate} onChange={(event) => setForm((current) => ({ ...current, orderDate: event.target.value }))} /></label>
                  <label className="grid gap-1 text-xs text-slate-500">Delivery date<Input type="date" value={form.deliveryDate} onChange={(event) => setForm((current) => ({ ...current, deliveryDate: event.target.value }))} /></label>
                </div>
                <label className="grid gap-1 text-xs text-slate-500">Order value (ex VAT)<Input type="number" step="0.01" min="0" inputMode="decimal" placeholder="0.00" required value={form.value} onChange={(event) => setForm((current) => ({ ...current, value: event.target.value }))} /></label>
                <div className="flex flex-wrap items-center gap-4">
                  <VatToggle registered={vat.registered} checked={formVatOn} onChange={(checked) => setForm((current) => ({ ...current, vatOn: checked }))} />
                  {vat.registered ? <VatRateSelect value={formVatChoice} disabled={!formVatOn} onChange={(choice) => setForm((current) => ({ ...current, vat: choice }))} /> : null}
                </div>
                <VatTotals totals={documentTotals([{ quantity: 1, unitPrice: Number(form.value) || 0, ...fromVatChoice(formVatChoice) }], 0, { vatEnabled: formVatOn, standardRate: vat.standardRate })} vatEnabled={formVatOn} totalLabel="Order total" />
                <Textarea placeholder="Notes" maxLength={2000} value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} />
                <Button type="submit" disabled={saving || (Boolean(form.quoteId) && quoteLink.state !== "ready")} className="bg-brand text-brand-ink">{saving ? "Saving…" : "Save Sales Order"}</Button>
              </form>
            </DialogContent>
          </Dialog>
          </div>
        </div>
        {DEMO_MODE ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Demo mode: sample data is shown if the database can&apos;t be reached.</div> : null}
        <div className="grid gap-4 md:grid-cols-3">
          {([["Open", counts.open, "open", "text-brand-accent"], ["Confirmed", counts.confirmed, "confirmed", "text-green-600 dark:text-green-400"], ["Despatched", counts.despatched, "despatched", "text-teal-600 dark:text-teal-400"]] as const).map(([label, value, filter, tone]) => (
            <Card key={label} className="cursor-pointer transition hover:bg-slate-50" onClick={() => { if (filter === "open") setPhase("open"); setFilters(filter === "open" ? new Set<string>(SALES_ORDER_OPEN_CARD_STATUSES) : new Set([filter])); }}><CardContent className="p-5"><ClipboardList className={`size-5 ${tone}`} /><p className="mt-3 text-sm text-slate-500">{label}</p><p className="text-3xl font-bold">{loading ? "—" : value}</p>{filter === "open" ? <p className="mt-1 text-xs text-slate-500">{SALES_ORDER_OPEN_CARD_NOTE}</p> : null}</CardContent></Card>
          ))}
        </div>
        <><PhaseFilter value={phase} onChange={setPhase} counts={phaseCounts} />
        <FilterBar activeValues={[...filters]} options={[{ label: "All", value: "all" }, { label: "Open", value: "open" }, { label: "Confirmed", value: "confirmed" }, { label: "In Production", value: "in_production" }, { label: "Despatched", value: "despatched" }, { label: "Converted", value: "converted" }, { label: "Closed", value: "closed" }]} onChange={setFilters} /></>
        <ListToolbar
          visibleCount={visible.length}
          selectedCount={selectedKeys.length}
          onSelectAll={() => setSelectedKeys(visible.map(keyOf))}
          onClear={() => setSelectedKeys([])}
          onPrint={printSelected}
          printDisabled={!selectedKeys.length}
          printTitle={selectedKeys.length ? undefined : "Select at least one sales order"}
          exports={[
            { label: "CSV", title: scopeTitle, onSelect: () => void exportSpreadsheet("csv", "Sales Orders", SALES_ORDER_COLUMNS, exportScope, "sales_orders") },
            { label: "Excel", title: scopeTitle, onSelect: () => void exportSpreadsheet("xlsx", "Sales Orders", SALES_ORDER_COLUMNS, exportScope, "sales_orders") },
          ]}
          actions={<>
            <Button className="bg-brand text-brand-ink" disabled={saving || !ordersToConvert(selectedOrders).length} title={ordersToConvert(selectedOrders).length ? undefined : selectedKeys.length ? "The selected orders already have jobs" : "Select at least one sales order"} onClick={() => void convertOrders(ordersToConvert(selectedOrders))}>{saving ? "Working…" : "Convert Selected to Jobs"}</Button>
            <Button variant="outline" disabled={saving || !ordersToDespatch(selectedOrders).length} title={ordersToDespatch(selectedOrders).length ? undefined : selectedKeys.length ? "None of the selected orders can be despatched (already converted, despatched or closed)" : "Select at least one sales order"} onClick={() => void despatchOrders(ordersToDespatch(selectedOrders))}>Despatch Selected</Button>
          </>}
        />
        {loadError ? (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <span>{loadError}</span>
            <Button variant="outline" size="sm" onClick={() => void loadOrders()}>Retry</Button>
          </div>
        ) : null}
        {loading ? <div className="space-y-3"><Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" /></div> : loadError && !DEMO_MODE ? null : visible.length === 0 ? (
          <EmptyList
            title={orders.length ? "No sales orders match this filter" : "No sales orders yet"}
            hint={orders.length ? "Try a different filter." : salesOrdersEmptyHint()}
            hintTestId={orders.length ? undefined : "empty-hint"}
            action={orders.length ? <Button variant="outline" onClick={() => setFilters(new Set(["all"]))}>Show all</Button> : <Button className="bg-brand text-brand-ink hover:bg-brand-hover" onClick={() => setNewOpen(true)}><Plus className="size-4" /> New sales order</Button>}
          />
        ) : (
          <Card><CardContent className="p-0"><Table data-view={view}>
            <TableHeader className="hidden md:table-header-group"><TableRow>
              <TableHead><SelectBox aria-label={`Select all ${visible.length} filtered orders`} checked={selectedKeys.length === visible.length && visible.length > 0} onChange={(event) => setSelectedKeys(event.target.checked ? visible.map(keyOf) : [])} /></TableHead>
              {isVisible("ref") ? <TableHead>SO Ref</TableHead> : null}{isVisible("customer") ? <TableHead>Customer</TableHead> : null}{isVisible("date") ? <TableHead>Order Date</TableHead> : null}{isVisible("delivery") ? <TableHead>Expected Delivery</TableHead> : null}{isVisible("value") ? <TableHead>Value</TableHead> : null}{isVisible("status") ? <TableHead>Status</TableHead> : null}<TableHead>Actions</TableHead>
            </TableRow></TableHeader>
            <TableBody>{visible.map((order) => (
              <TableRow key={keyOf(order)} className={order.status === "despatched" ? "block bg-green-50 md:table-row" : "block md:table-row"}>
                <TableCell className="block md:table-cell"><SelectBox aria-label={`Select ${order.ref}`} checked={selectedKeys.includes(keyOf(order))} onChange={() => toggleSelected(order)} /></TableCell>
                {isVisible("ref") ? <TableCell data-label="SO Ref" className="block font-mono font-semibold md:table-cell">{order.ref}</TableCell> : null}
                {isVisible("customer") ? <TableCell data-label="Customer" className="block md:table-cell">{order.customer || "Customer not linked"}</TableCell> : null}
                {isVisible("date") ? <TableCell data-label="Order Date" className="block md:table-cell">{fmtDate(order.date)}</TableCell> : null}
                {isVisible("delivery") ? <TableCell data-label="Expected Delivery" className="block md:table-cell">{fmtDate(order.delivery)}</TableCell> : null}
                {isVisible("value") ? <TableCell data-label="Value" className="block md:table-cell">{currency(order.value)}</TableCell> : null}
                {isVisible("status") ? <TableCell data-label="Status" className="block md:table-cell"><StatusBadge status={salesOrderStatusKey(order.status)} label={order.status.replaceAll("_", " ")} className="capitalize" /></TableCell> : null}
                <TableCell data-actions className="block md:table-cell"><div className="flex flex-wrap items-center gap-2">
                  <div className="flex shrink-0 items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => setSelected(order)}>View</Button>
                    {archive.canManage ? <ArchiveButton id={order.id ? String(order.id) : undefined} phase={phaseFor(order)} manual={order.id ? archive.manual.get(String(order.id)) : undefined} onSet={archive.setState} /> : null}
                  </div>
                  {editBlockedReason(order) ? <span title={editBlockedReason(order) ?? undefined} data-testid="so-edit-blocked-row" className="inline-flex"><Button variant="outline" size="sm" disabled>Edit</Button></span> : <Button variant="outline" size="sm" onClick={() => startEdit(order)}>Edit</Button>}
                  {order.id && !order.customerPo ? <Button variant="outline" size="sm" aria-label={`Add customer PO to ${order.ref}`} onClick={() => { setPoDraft(""); setPoOrder(order); }}>Add customer PO</Button> : null}
                  {order.id ? <Button variant="outline" size="sm" aria-label={`Machines for ${order.ref}`} onClick={() => setMachinesOrder(order)}>Machines</Button> : null}
                  {isConverted(order) ? null : <Button size="sm" disabled={saving} onClick={() => void convertOrders([order])} className="bg-brand text-brand-ink">Convert to Job</Button>}
                  {canDespatch(order) ? <Button variant="outline" size="sm" disabled={saving} onClick={() => void despatchOrders([order])}>Despatch</Button> : null}
                </div></TableCell>
              </TableRow>
            ))}</TableBody>
          </Table></CardContent></Card>
        )}
        <Dialog open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>{selected?.ref}</DialogTitle><DialogDescription>Sales order detail</DialogDescription></DialogHeader>
            {selected ? <div className="space-y-3 text-sm"><p><strong>Customer:</strong> {selected.customer}</p><p><strong>Order date:</strong> {fmtDate(selected.date)}</p><p><strong>Expected delivery:</strong> {fmtDate(selected.delivery) || "Not set"}</p><p><strong>Value:</strong> {currency(selected.value)}</p><p><strong>Status:</strong> {selected.status}</p>{selected.quoteRef ? <p><strong>Quote:</strong> {selected.quoteRef}</p> : null}<p><strong>Customer PO:</strong> {selected.customerPo || "Not received yet"}{selected.id && !selected.customerPo ? <Button variant="outline" size="sm" className="ml-2" onClick={() => { setPoDraft(""); setPoOrder(selected); }}>Add customer PO</Button> : null}</p>{selected.convertedJob ? <p><strong>Linked job:</strong> {selected.convertedJob}</p> : null}{editBlockedReason(selected) ? <p data-testid="so-edit-blocked" className="text-slate-600">{editBlockedReason(selected)}</p> : null}<p data-testid="so-machines-chips"><strong>Machines:</strong> {(selected.id && planByOrder.get(selected.id)) || "None planned"}{selected.convertedJob && selected.id && planByOrder.get(selected.id) ? " (as ordered; the job holds the plan now)" : ""}</p><div className="flex flex-wrap gap-2">{isConverted(selected) ? null : <Button disabled={saving} onClick={() => void convertOrders([selected])} className="bg-brand text-brand-ink">Convert to Job</Button>}{canDespatch(selected) ? <Button variant="outline" disabled={saving} onClick={() => void despatchOrders([selected])}>Despatch</Button> : null}{selected.id ? <Button variant="outline" onClick={() => setMachinesOrder(selected)}>Machines</Button> : null}<Button variant="outline" onClick={() => window.open(`/sales-orders/${encodeURIComponent(selected.id ?? selected.ref)}/print`, "_blank")}>Print</Button><Button variant="outline" onClick={() => void downloadSalesOrderPdf(selected)}>Download PDF</Button></div></div> : null}
          <ActivityPanel table="sales_orders" recordId={selected?.id} className="mt-4" /></DialogContent>
        </Dialog>
        <SoMachinesDialog order={machinesOrder?.id ? { id: machinesOrder.id, ref: machinesOrder.ref, converted: machinesOrder.status === "converted" || Boolean(machinesOrder.convertedJob) } : null} onClose={() => setMachinesOrder(null)} onSaved={() => { void loadPlans().then((map) => { if (map) setPlanByOrder(map); }); }} />
        <Dialog open={Boolean(poOrder)} onOpenChange={(open) => { if (!open) { setPoOrder(null); setPoDraft(""); } }}>
          <DialogContent>
            <DialogHeader><DialogTitle>Add customer PO to {poOrder?.ref}</DialogTitle><DialogDescription>The customer&apos;s order number. A provisional SO number is replaced by it, and a job made from this order that isn&apos;t finished gets it on its worksheet.</DialogDescription></DialogHeader>
            <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void saveCustomerPo(); }}>
              <Input aria-label="Customer PO" placeholder="Customer order number (their PO)" maxLength={100} required value={poDraft} onChange={(event) => setPoDraft(event.target.value)} />
              <Button type="submit" disabled={saving || !poDraft.trim()} className="bg-brand text-brand-ink">{saving ? "Saving…" : "Save customer PO"}</Button>
            </form>
          </DialogContent>
        </Dialog>
        <Dialog open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Edit {editing?.ref}</DialogTitle><DialogDescription>Update customer order information.</DialogDescription></DialogHeader>
            {editing ? (
              <div className="grid gap-3">
                <CustomerSelect name="edit_customer" value={editDraft.customer} onValueChange={(customer) => setEditDraft((draft) => ({ ...draft, customer }))} />
                <label className="grid gap-1 text-xs text-slate-500">Delivery date<Input type="date" value={editDraft.delivery} onChange={(event) => setEditDraft((draft) => ({ ...draft, delivery: event.target.value }))} /></label>
                <label className="grid gap-1 text-xs text-slate-500">Order value (ex VAT)<Input type="number" step="0.01" min="0" inputMode="decimal" value={editDraft.value} onChange={(event) => setEditDraft((draft) => ({ ...draft, value: event.target.value }))} /></label>
                <div className="flex flex-wrap items-center gap-4">
                  <VatToggle registered={vat.registered} checked={editDraft.vatOn && vat.registered} onChange={(checked) => setEditDraft((draft) => ({ ...draft, vatOn: checked }))} />
                  {vat.registered ? <VatRateSelect value={editDraft.vat} disabled={!editDraft.vatOn} onChange={(choice) => setEditDraft((draft) => ({ ...draft, vat: choice }))} /> : null}
                </div>
                <Button disabled={saving} onClick={() => void saveEdit()} className="bg-brand text-brand-ink">{saving ? "Saving…" : "Save Changes"}</Button>
              </div>
            ) : null}
          </DialogContent>
        </Dialog>
      </div>
    </RoleGate>
  );
}
