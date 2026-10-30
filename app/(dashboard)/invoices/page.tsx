"use client";

import { deletedOne } from "@/lib/delete-result";
import { EmptyList } from "@/components/empty-list";
import { ActivityPanel } from "@/components/activity-panel";
import { AiFinanceCheckPanel } from "@/components/ai-finance-check-panel";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Banknote, Plus, Send, Trash2, TrendingDown } from "lucide-react";

import { FilterBar } from "@/components/filter-bar";
import { ArchiveButton, PhaseFilter } from "@/components/phase-filter";
import { phaseOf, type PhaseFilterValue, useArchive } from "@/lib/archive";
import { DateRangeFields } from "@/components/date-range-fields";
import { ColumnToggle } from "@/components/column-toggle";
import { ListToolbar } from "@/components/list-toolbar";
import { ViewSwitcher } from "@/components/view-switcher";
import { useViewMode } from "@/lib/view-mode";
import { CompactInvoiceList } from "@/components/invoices/compact-invoice-list";
import { useCompactList } from "@/lib/compact-list-pref";
import { RoleGate } from "@/components/role-gate";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/status-badge";
import { invoiceStatusKey } from "@/lib/status-colours";
import { Button } from "@/components/ui/button";
import { SelectBox } from "@/components/ui/select-box";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { CustomerSelect } from "@/components/customer-select";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { storedTotalsProblem } from "@/components/pdf/BaseDocumentPDF";
import { InvoicePDF } from "@/components/pdf/InvoicePDF";
import { auditEvent } from "@/lib/audit";
import { type CompanyProfile, requireCompanyProfile, useCompanyProfile } from "@/lib/company";
import { fetchCustomers, findCustomer, resolveCustomer, resolveCustomerAddress } from "@/lib/customers";
import { DEMO_MODE } from "@/lib/demo";
import { ListFilterNotice, useListFilter } from "@/components/list-filter-notice";
import { DRAFT_INVOICE_DAYS, DRAFT_INVOICE_RULE_TITLE } from "@/lib/attention-items";
import { draftInvoiceCounts, invoiceMatchesFilter } from "@/lib/list-filter";
import { fmtDate, fmtDateTime, nowIso, toDateInput } from "@/lib/dates";
import { downloadPdf, openMailDraft, pdfBlob, pdfErrorMessage } from "@/lib/download-pdf";
import { type SendEmailRequest, SendEmailDialog } from "@/components/email/send-email-button";
import { type TemplateVars, invoiceReminderVars, renderTemplate } from "@/lib/email/templates/defaults";
import { loadTemplateOverride } from "@/lib/email/templates/store";
import { EXPORT_TITLES, exportRows, exportSpreadsheet } from "@/lib/export-records";
import { INVOICE_COLUMNS, PAYMENT_COLUMNS, paymentExportRows } from "@/lib/import-columns";
import { exportScopeRows, exportScopeTitle } from "@/lib/spreadsheet";
import { friendlyError } from "@/lib/friendly-error";
import { linkedInvoiceId } from "@/lib/invoice-link";
import { useUser } from "@/lib/use-user";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CreditNotesPanel } from "@/components/credit-notes-panel";
import { CustomerCreditPanel } from "@/components/customer-credit-panel";
import { InvoiceDeliveryNotes } from "@/components/invoice-delivery-notes";
import { InvoiceDeliveryNoteFiles } from "@/components/document-attachments";
import { DraftInvoiceEditor } from "@/components/draft-invoice-editor";
import { useDatabaseHas067 } from "@/lib/use-database-has-067";
import { useDatabaseHas073 } from "@/lib/use-database-has-073";
import { VoidInvoiceDialog } from "@/components/void-invoice-dialog";
import { chipsForPhase } from "@/lib/invoice-phase-filters";
import { isVoid, voidOffered } from "@/lib/invoice-void";
import { deliveryAddressLines, optionalColumn } from "@/lib/invoice-fields";
import { InvoiceFromDeliveryNotes } from "@/components/invoice-from-delivery-notes";
import { deliveryNotesPrintedLine, fetchInvoiceNotes, type InvoiceNote } from "@/lib/invoice-delivery-notes";
import { invoiceCustomerSignOff } from "@/lib/customer-signoff-print";
import { UninvoicedDeliveryNotes } from "@/components/uninvoiced-delivery-notes";
import { issuedBillTo } from "@/lib/document-snapshot";
import { invoiceDisplayTotals, invoiceIssuer } from "@/lib/invoice-totals";
import { InvoiceRefCell } from "@/components/invoice-ref-cell";
import { type FlowJob, jobDraftStage } from "@/lib/job-flow";
import { draftKey, shownInvoiceRef } from "@/lib/invoice-ref";
import { INVOICE_SHOW_NOTE, raisedCaption } from "@/lib/range-label";
import { DRAFT_PAYMENT_REASON, balanceDue, customerCredit, daysPastDue, invoiceDetailStatusLabel, invoiceLifecycle, invoiceStatus, isPartPaid, isRaised, paidOnTime, paidOnTimeNote, paymentBlockedReason } from "@/lib/receivables";
import { invoicePdfCredits, invoicePdfPayments } from "@/lib/invoice-pdf-data";
import { PaymentAttempts, recordBatch, recordWithRecovery, type PaymentOutcome } from "@/lib/payment-attempts";
import { PAYMENT_METHODS, type InvoicePayment, netPaid, paymentAmountProblem, paymentDateProblem, paymentFromRow, paymentsEmptyText } from "@/lib/payments";
import { documentTotals, fromPence, gbp, isTextLine, toPence } from "@/lib/money";
import { companyVat, fromVatChoice, type VatChoice } from "@/lib/vat";
import { VatRateSelect, VatToggle } from "@/components/vat-controls";
import { VatTotals } from "@/components/vat-totals";
import { useColumnVisibility } from "@/lib/org-settings";
import { confirmPageCompany } from "@/lib/page-company";
import { supabase } from "@/lib/supabase";
import { JobPicker } from "@/components/job-picker";
import { type PickerJob, invoiceFieldsFromJob, jobSurvivesCustomerChange } from "@/lib/job-picker";
import { getCurrentOrganizationId } from "@/lib/supabase-business";
import { useSaving } from "@/lib/use-saving";
import { ValidationError, invoiceSaveSchema, parseOrThrow, userMessage } from "@/lib/validation/schemas";
import { fetchAll, truncationNotice } from "@/lib/fetch-all";
import { nudgeIntegrationSend } from "@/lib/integrations/nudge";
import { invoicesEmptyHint } from "@/lib/empty-hints";

type InvoiceLine = { description: string; quantity: number; unitPrice: number; vatPct: number; vatExempt?: boolean };

/** What is stored. Status, days overdue etc. are derived from dueDate and the raw status each render. */
const INVOICE_FILTER_LABELS: Record<string, string> = { overdue: "Overdue invoices", "draft-old": DRAFT_INVOICE_RULE_TITLE };

type InvoiceBase = {
  id?: string;
  /** ISO timestamp the row was created. */
  createdAt?: string;
  /** invoices.updated_at: the token a draft correction must present (replace_draft_invoice, migration 067). */
  updatedAt?: string;
  /** The invoice number, or for a draft with none a stable key (lib/invoice-ref): use shownInvoiceRef to show it. */
  reference: string;
  /** A draft with no invoice number yet: `reference` is then only a key. */
  unnumbered?: boolean;
  customer: string;
  /** Stored total, including carriage and VAT. */
  amount: number;
  /** Stored subtotal and VAT, as issued (absent on demo data). */
  subtotal?: number;
  vatAmount?: number;
  rawStatus: string;
  /** ISO (YYYY-MM-DD) invoice date. */
  date?: string;
  /** ISO (YYYY-MM-DD) due date. */
  dueDate?: string;
  /** ISO (YYYY-MM-DD) date of supply, when one was set on the draft. Printed only when it differs from `date`. */
  taxPoint?: string;
  terms?: string;
  quoteRef?: string;
  customerPo?: string;
  /** The job the invoice is for (invoices.job_id): where its delivery notes are found when none is linked directly. */
  jobId?: string;
  carriage: number;
  /** "Add VAT" on this invoice (existing invoices: on). */
  vatEnabled: boolean;
  /** Carriage taxed at the standard rate (invoices created with the VAT options; older ones: off). */
  carriageVat: boolean;
  /** Credits applied to the invoice (credit notes, customer credit moved from another invoice; migration 034): they settle part of it but are not payments. */
  credited: number;
  /** Customer credit that left the invoice: refunded, or applied to another invoice. */
  refunded: number;
  /** Everything received so far: the sum of its payments (invoice_payments, migration 032). */
  amountPaid: number;
  /** ISO timestamp the invoice was settled (set when the payment that clears it is recorded). */
  paidAt?: string;
  /** ISO timestamp someone confirmed the invoice e-mail went out (separate from issuing). */
  sentAt?: string;
  /** Imported without payment details: to be confirmed before it counts as owed (migration 027). */
  paymentUnverified?: boolean;
  /** The single description/qty/price stored on the invoice header, used when there are no line items. */
  headerLine?: InvoiceLine;
  /** Real line items, when known (demo data). Saved invoices load theirs from invoice_line_items. */
  lines?: InvoiceLine[];
  /** Issuer / customer details recorded when the invoice was issued (migration 019); absent on older invoices. */
  issuerSnapshot?: unknown;
  customerSnapshot?: unknown;
  /** One-line note printed on the invoice (migration 073). undefined: the database has no such column yet; null: none. */
  invoiceNote?: string | null;
  /** Delivery address printed under Deliver To (migration 073). undefined: no such column yet; null: none (the invoice address prints). */
  deliveryAddress?: string | null;
};

type InvoiceRow = InvoiceBase & {
  /** "closed": draft, void, cancelled or credited; never collected (lib/receivables). */
  status: "overdue" | "outstanding" | "paid" | "closed" | "unverified";
  /** Positive = days past due, negative = days until due, 0 = due today or no due date. */
  daysOverdue: number;
  /** Still to collect: face value minus receipts (0 when paid or closed). */
  balance: number;
  /** Some, but not all, has been received ("Part paid"): still open and collectible for the balance. */
  partPaid: boolean;
};

const currency = (value: number) => gbp(value, 2);

/** The invoice e-mail's values (Settings > Email templates; lib/email/templates). */
function invoiceEmailVars(invoice: InvoiceRow, companyName: string): TemplateVars {
  return { document_number: invoice.reference, company_name: companyName, customer_name: invoice.customer, total: currency(invoice.amount), due_date: invoice.dueDate ? fmtDate(invoice.dueDate) : "" };
}

/** Whether a payment with this request id exists on the invoice (and the invoice's figures if so); `error` when it can't be asked. */
async function findPaymentOutcome(invoiceId: string, requestId: string): Promise<{ outcome: PaymentOutcome | null; error: unknown }> {
  if (!supabase) return { outcome: null, error: new Error("Supabase is not configured.") };
  const found = await supabase.from("invoice_payments").select("id").eq("invoice_id", invoiceId).eq("request_id", requestId).maybeSingle();
  if (found.error) return { outcome: null, error: found.error };
  if (!found.data) return { outcome: null, error: null };
  const inv = await supabase.from("invoices").select("status, amount_paid, credited_amount, refunded_amount, total").eq("id", invoiceId).single();
  if (inv.error) return { outcome: null, error: inv.error };
  return { outcome: { status: String(inv.data.status), amountPaid: Number(inv.data.amount_paid), balance: balanceDue(Number(inv.data.total), Number(inv.data.amount_paid), Number(inv.data.credited_amount), Number(inv.data.refunded_amount)) }, error: null };
}

/** How long the payment history may take before its section stops saying "Loading". */
const PAYMENTS_READ_TIMEOUT_MS = 10_000;

const UNCERTAIN_MESSAGE = "We couldn't confirm whether this payment was saved: it may have been. Press Check and save to find out. The same payment is never recorded twice.";

function daysBetween(laterIso: string, earlierIso: string) {
  return Math.round((Date.parse(`${laterIso.slice(0, 10)}T00:00:00Z`) - Date.parse(`${earlierIso.slice(0, 10)}T00:00:00Z`)) / 86400000);
}

function addDays(iso: string, days: number) {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Days implied by a terms string such as "30 days" or "Due on receipt". */
function termsDays(terms: string) {
  if (/receipt/i.test(terms)) return 0;
  const match = /(\d+)/.exec(terms);
  return match ? Number(match[1]) : 30;
}

function derive(base: InvoiceBase, today: string): InvoiceRow {
  const lifecycle = invoiceLifecycle(base.rawStatus);
  if (lifecycle === "paid") return { ...base, status: "paid", daysOverdue: 0, balance: 0, partPaid: false };
  if (lifecycle === "closed") return { ...base, status: "closed", daysOverdue: 0, balance: 0, partPaid: false };
  // Imported without payment details: neither owed nor paid until someone checks (migration 027).
  if (base.paymentUnverified) return { ...base, status: "unverified", daysOverdue: 0, balance: 0, partPaid: false };
  const daysOverdue = daysPastDue(base.dueDate, today) ?? 0;
  const partPaid = isPartPaid({ status: base.rawStatus, total: base.amount, amount_paid: base.amountPaid, credited_amount: base.credited, refunded_amount: base.refunded });
  return { ...base, status: daysOverdue > 0 ? "overdue" : "outstanding", daysOverdue, balance: balanceDue(base.amount, base.amountPaid, base.credited, base.refunded), partPaid };
}

/** Demo mode only. JNR's real records are imported lazily so they never ship in the production bundle. */
async function loadDemoInvoices(): Promise<InvoiceBase[]> {
  const m = await import("@/lib/jnr-test-data");
  return m.JNR_TEST_INVOICES.map((invoice): InvoiceBase => ({
    reference: invoice.ref,
    customer: invoice.customer,
    amount: invoice.total,
    credited: 0,
    refunded: 0,
    rawStatus: invoiceStatus(invoice.status),
    date: invoice.date,
    dueDate: invoice.dueDate,
    terms: invoice.terms,
    quoteRef: invoice.quoteRef,
    customerPo: invoice.customerPo,
    carriage: 0,
    vatEnabled: true,
    carriageVat: false,
    amountPaid: invoice.total,
    lines: invoice.lines,
  }));
}

async function fetchInvoiceLines(invoice: InvoiceBase): Promise<InvoiceLine[]> {
  if (invoice.lines?.length) return invoice.lines;
  if (!supabase || !invoice.id) return invoice.headerLine ? [invoice.headerLine] : [];
  const { data, error } = await supabase.from("invoice_line_items").select("description, quantity, unit_price, vat_pct, vat_exempt").eq("invoice_id", invoice.id).order("position");
  if (error) throw error;
  const lines = (data ?? []).map((row) => ({ description: String(row.description || ""), quantity: Number(row.quantity || 0), unitPrice: Number(row.unit_price || 0), vatPct: Number(row.vat_pct ?? 20), vatExempt: Boolean(row.vat_exempt) }));
  return lines.length ? lines : invoice.headerLine ? [invoice.headerLine] : [];
}

function invoiceStoredTotals(invoice: InvoiceBase) {
  return { reference: invoice.reference, issued: invoice.rawStatus !== "draft", total: invoice.amount, subtotal: invoice.subtotal, vat: invoice.vatAmount };
}

/** Why this invoice can't be printed from its lines (they don't add up to its stored totals), or null. */
function invoiceTotalsProblem(invoice: InvoiceBase, lines: InvoiceLine[], company: CompanyProfile) {
  return storedTotalsProblem({
    lineItems: lines, carriage: invoice.carriage, showVat: invoice.vatEnabled, carriageVat: invoice.carriageVat, company,
    storedTotals: invoiceStoredTotals(invoice),
  });
}

const AGING = [
  { label: "Current", color: "text-blue-700", test: (days: number) => days <= 0 },
  { label: "1-30 days late", color: "text-amber-700", test: (days: number) => days >= 1 && days <= 30 },
  { label: "31-60 days late", color: "text-orange-700", test: (days: number) => days >= 31 && days <= 60 },
  { label: "60+ days late", color: "text-red-700", test: (days: number) => days > 60 },
];

export default function InvoicesPage() {
  const { isVisible } = useColumnVisibility("invoices");
  // Cards / List / Table, remembered per person (lib/view-mode; styles in app/globals.css [data-view]).
  const [view, setView] = useViewMode("invoices", "table");
  const [compact, setCompact] = useCompactList("invoices");
  const { profile: company } = useCompanyProfile();
  const vat = companyVat(company);
  const { saving, run } = useSaving();
  const [today] = useState(() => toDateInput(new Date()));
  const [rows, setRows] = useState<InvoiceBase[]>([]);
  const [filters, setFilters] = useState(new Set(["all"]));
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // Create form VAT: null = follow the company settings.
  const [formVat, setFormVat] = useState<boolean | null>(null);
  const [formVatChoice, setFormVatChoice] = useState<VatChoice | null>(null);
  const [formQty, setFormQty] = useState("1");
  // Optional: the job the invoice is for. Picking one fills the customer, our quote number and the customer's PO (still editable) and
  // links the invoice to the job (invoices.job_id, which create_with_lines accepts as a header column of the invoices table).
  const [formCustomer, setFormCustomer] = useState("");
  const [formQuoteRef, setFormQuoteRef] = useState("");
  const [formCustomerPo, setFormCustomerPo] = useState("");
  const [formJob, setFormJob] = useState<PickerJob | null>(null);
  /** Picking a job sets the customer, quote number and PO from it (a field the job lacks is cleared); picking none changes nothing. */
  function pickFormJob(job: PickerJob | null) {
    setFormJob(job);
    if (!job) return;
    const fields = invoiceFieldsFromJob(job);
    setFormCustomer(fields.customer);
    setFormQuoteRef(fields.quoteRef);
    setFormCustomerPo(fields.customerPo);
  }
  /** Changing the customer to another one drops the job link: the invoice would otherwise be linked to a job of someone else. */
  function changeFormCustomer(name: string) {
    setFormCustomer(name);
    if (formJob && !jobSurvivesCustomerChange(formJob, name)) setFormJob(null);
  }
  const [formUnit, setFormUnit] = useState("");
  /** Lines after the first (audit D16): each with its own description, quantity, price and VAT. */
  const [extraLines, setExtraLines] = useState<{ description: string; qty: string; unit: string; vat: VatChoice }[]>([]);
  const [formCarriage, setFormCarriage] = useState("0");
  /** The invoice a payment is being recorded against, and the dialog's fields (amount starts at the balance due). */
  const [paymentFor, setPaymentFor] = useState<InvoiceRow | null>(null);
  // When the payment dialog was opened: a payment recorded on the invoice after this (another tab, a double click) stops a second one.
  const [payOpenedAt, setPayOpenedAt] = useState(0);
  const [payAmount, setPayAmount] = useState("");
  const [payDate, setPayDate] = useState(today);
  const [payMethod, setPayMethod] = useState("BACS");
  const [payReference, setPayReference] = useState("");
  const [payError, setPayError] = useState<string | null>(null);
  /** One id per opening of the dialog: a repeated submit (double click, retry) is the same payment, recorded once. */
  /** The attempt stays (same request id, same values) while its outcome is uncertain, even if the dialog is closed. */
  const { user: signedIn, profile: signedInProfile } = useUser();
  // Registered per signed-in user and company, in this browser's storage, so an uncertain save survives a reload.
  const attempts = useMemo(() => (signedIn?.id && signedInProfile?.organization_id ? new PaymentAttempts(signedIn.id, signedInProfile.organization_id) : new PaymentAttempts("unknown", "unknown", null)), [signedIn?.id, signedInProfile?.organization_id]);
  const [payUncertain, setPayUncertain] = useState(false);
  // Bumped whenever an attempt may have changed, so the list of invoices with an unknown outcome is read again.
  const [attemptsVersion, setAttemptsVersion] = useState(0);
  /** The invoice being confirmed as having all its payments recorded (payment to confirm), and the note. */
  const [confirmFor, setConfirmFor] = useState<InvoiceRow | null>(null);
  const [confirmNote, setConfirmNote] = useState("");
  /** Bulk "pay in full" waiting for confirmation (audit D18): exactly these invoices are written, each for its balance. */
  const [bulkToPay, setBulkToPay] = useState<InvoiceRow[] | null>(null);
  // Reversing a payment and confirming imported payments stay with admins (the database refuses anyone else too).
  const { hasRole } = useUser();
  /** Edit Draft needs replace_draft_invoice (067): hidden until the database has it, so the app can go out before the SQL. */
  const draftEditAvailable = useDatabaseHas067() === true;
  /** Void, £0 text lines, the note, the delivery address and the customer's mobile need 073: hidden until the database has it. */
  const has073 = useDatabaseHas073() === true;
  /** The invoice being voided (asks for the reason). */
  const [voidFor, setVoidFor] = useState<InvoiceRow | null>(null);
  const isAdmin = hasRole("admin");
  /** "Issue & send" on a draft: admin and office (workshop and viewer never issue or send). */
  const canIssueAndSend = isAdmin || hasRole("office");
  /** The payment being reversed, and why. */
  const [reversing, setReversing] = useState<InvoicePayment | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const [reverseTried, setReverseTried] = useState(false);
  /** Payment history of the invoice on screen; bumped to load it again after a payment or a reversal. */
  const [payments, setPayments] = useState<InvoicePayment[]>([]);
  const [paymentsVersion, setPaymentsVersion] = useState(0);
  /** Whether `payments` is what the database returned for the invoice on screen (false while it is being fetched). */
  const [paymentsLoaded, setPaymentsLoaded] = useState(false);
  const [paymentsError, setPaymentsError] = useState<string | null>(null);
  /** Who recorded each payment, by display name (admins can read the company's members). */
  const [memberNames, setMemberNames] = useState<Map<string, string>>(new Map());
  const [viewingInvoice, setViewingInvoice] = useState<InvoiceRow | null>(null);
  // A prepared e-mail waiting for "I've sent it": opening a draft or downloading the PDF doesn't prove it went.
  const [sendConfirm, setSendConfirm] = useState<InvoiceRow | null>(null);
  const [emailRequest, setEmailRequest] = useState<SendEmailRequest | null>(null);
  const [issueConfirm, setIssueConfirm] = useState<InvoiceRow | null>(null);
  /** The issue confirmation was opened from "Issue & send": send it to the customer straight after issuing. */
  const [issueThenSend, setIssueThenSend] = useState(false);
  /** Deleting a draft asks first: it cannot be brought back. */
  const [deleteDraftConfirm, setDeleteDraftConfirm] = useState<InvoiceRow | null>(null);
  /** The draft on screen is being edited (migration 067); after a save the list is read again and the draft reopened from it. */
  const [editingDraft, setEditingDraft] = useState(false);
  const [reopenId, setReopenId] = useState<string | null>(null);
  const [trendRange, setTrendRange] = useState(() => ({ from: `${today.slice(0, 8)}01`, to: today }));
  const [selectedInvoices, setSelectedInvoices] = useState<string[]>([]);
  const [viewLines, setViewLines] = useState<InvoiceLine[]>([]);
  const [viewAddress, setViewAddress] = useState<string[]>([]);
  /** The customer's mobile (migration 073), from the customer record. */
  const [viewMobile, setViewMobile] = useState("");
  const [viewError, setViewError] = useState<string | null>(null);
  // Create-invoice form state: due date follows the invoice date + terms until the user edits it.
  const [formTerms, setFormTerms] = useState("30 days");
  /** "Invoice from delivery notes" (migration 034). */
  const [fromNotesOpen, setFromNotesOpen] = useState(false);
  /** Invoices drafted automatically when a delivery note went out (migration 059): invoice id -> the note's number. */
  const [autoDrafted, setAutoDrafted] = useState<Map<string, string>>(new Map());
  /** 081: the flow of each job a draft is for: "Draft, awaiting inspection" until the job is Complete, then "Ready to issue". */
  const [draftJobs, setDraftJobs] = useState<Map<string, FlowJob>>(new Map());
  /** Bumped after every load so "Sent but not invoiced" reads again. */
  const [backlogKey, setBacklogKey] = useState(0);
  /** Customer credit held across all customers (migration 034), shown above the list. */
  const [creditHeld, setCreditHeld] = useState<{ total: number; customers: number }>({ total: 0, customers: 0 });
  const [formDate, setFormDate] = useState(today);
  const [formDue, setFormDue] = useState(addDays(today, 30));
  const [dueTouched, setDueTouched] = useState(false);

  const invoices = useMemo(() => rows.map((row) => derive(row, today)), [rows, today]);
  // After a draft was corrected: show it again as now stored (its new totals and token).
  useEffect(() => {
    if (!reopenId) return;
    const fresh = invoices.find((invoice) => invoice.id === reopenId);
    if (fresh) { setViewingInvoice(fresh); setReopenId(null); }
  }, [invoices, reopenId]);
  // A link from elsewhere (a delivery note) names an invoice as /invoices?invoice=<id>: once the list has loaded, open that invoice (once).
  // It is looked up only among the invoices this person can already read, so an id from another company, or one that is gone, opens nothing.
  const linkedInvoiceDone = useRef(false);
  useEffect(() => {
    if (linkedInvoiceDone.current || loading) return;
    linkedInvoiceDone.current = true;
    const id = linkedInvoiceId(window.location.search);
    if (!id) return;
    const found = invoices.find((invoice) => invoice.id === id);
    if (found) setViewingInvoice(found);
    else if (!loadError) toast.info("That invoice isn't available. It may have been deleted, or it isn't yours to see.");
  }, [loading, loadError, invoices]);
  // Invoices with a payment attempt whose outcome is unknown (bulk or single): each can be checked and saved on its own.
  const uncertainInvoices = useMemo(() => invoices.filter((invoice) => attempts.isUncertain(invoice.id ?? invoice.reference)), [invoices, attempts, attemptsVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Reads every invoice again. Returns the rows as stored, or null when they couldn't be read (so a caller never trusts a stale copy). */
  const loadInvoices = useCallback(async (): Promise<InvoiceBase[] | null> => {
    setLoading(true);
    setLoadError(null);
    let loaded: InvoiceBase[] | null = null;
    try {
      if (!supabase) throw new Error("Supabase is not configured yet.");
      // Every row, page by page (lib/fetch-all): the API returns at most 1,000 per request.
        const { rows: data, truncated } = await fetchAll((from, to) => supabase!.from("invoices").select("*").order("created_at", { ascending: false }).order("id").range(from, to));
        const error = null;
        if (truncated) toast.warning(truncationNotice(data.length));
      if (error) throw error;
      // Trust the database, including an empty result.
      loaded = ((data ?? []) as Array<Record<string, unknown>>).map((invoice): InvoiceBase => ({
        id: invoice.id ? String(invoice.id) : undefined,
        date: invoice.invoice_date ? String(invoice.invoice_date).slice(0, 10) : invoice.created_at ? toDateInput(String(invoice.created_at)) : undefined,
        createdAt: invoice.created_at ? String(invoice.created_at) : undefined,
        updatedAt: invoice.updated_at ? String(invoice.updated_at) : undefined,
        dueDate: invoice.due_date ? String(invoice.due_date).slice(0, 10) : undefined,
        taxPoint: invoice.tax_point ? String(invoice.tax_point).slice(0, 10) : undefined,
        terms: invoice.terms ? String(invoice.terms) : undefined,
        quoteRef: invoice.quote_ref ? String(invoice.quote_ref) : undefined,
        customerPo: invoice.customer_po ? String(invoice.customer_po) : undefined,
        jobId: invoice.job_id ? String(invoice.job_id) : undefined,
        carriage: Number(invoice.carriage || 0),
        vatEnabled: invoice.vat_enabled !== false,
        carriageVat: invoice.carriage_vat === true,
        amountPaid: Number(invoice.amount_paid || 0),
        credited: Number(invoice.credited_amount || 0),
        refunded: Number(invoice.refunded_amount || 0),
        paidAt: invoice.paid_at ? String(invoice.paid_at) : undefined,
        // Drafts have no number until issued: a stable key from the id keeps them apart in the list (shown as "Draft, no number yet").
        reference: invoice.invoice_ref ? String(invoice.invoice_ref) : draftKey(String(invoice.id)),
        unnumbered: !invoice.invoice_ref,
        sentAt: invoice.sent_date ? String(invoice.sent_date) : undefined,
        paymentUnverified: invoice.payment_unverified === true,
        customer: String(invoice.customer || ""),
        amount: Number(invoice.total || 0),
        subtotal: invoice.subtotal === null || invoice.subtotal === undefined ? undefined : Number(invoice.subtotal),
        vatAmount: invoice.vat === null || invoice.vat === undefined ? undefined : Number(invoice.vat),
        rawStatus: invoiceStatus(invoice.status as string | null),
        headerLine: invoice.description ? { description: String(invoice.description), quantity: Number(invoice.quantity || 1), unitPrice: Number(invoice.unit_price || 0), vatPct: 20 } : undefined,
        issuerSnapshot: invoice.issuer_snapshot ?? undefined,
        customerSnapshot: invoice.customer_snapshot ?? undefined,
        invoiceNote: optionalColumn(invoice, "invoice_note"),
        deliveryAddress: optionalColumn(invoice, "delivery_address"),
      }));
      setRows(loaded);
      // Which drafts the database made from a delivery note (059). An older database has no such table: no badges.
      const { rows: drafted } = await fetchAll((from, to) => supabase!.from("invoice_queue_events").select("id, invoice_id, delivery_notes(dn_number)").eq("outcome", "drafted").not("invoice_id", "is", null).order("id").range(from, to))
        .catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
      setAutoDrafted(new Map((drafted as Array<Record<string, unknown>>).map((row) => {
        const note = row.delivery_notes as { dn_number?: string } | Array<{ dn_number?: string }> | null;
        const ref = Array.isArray(note) ? note[0]?.dn_number : note?.dn_number;
        return [String(row.invoice_id), String(ref ?? "a delivery note")] as const;
      })));
      // The jobs the drafts are for (one draft per job since 081). Without them the drafts just read as drafts.
      const draftJobIds = [...new Set(loaded.filter((invoice) => invoice.rawStatus === "draft" && invoice.jobId).map((invoice) => invoice.jobId!))];
      if (draftJobIds.length) {
        const { data: flows } = await supabase.from("jobs").select("id, finished_at, inspected_at, stage").in("id", draftJobIds.slice(0, 500));
        setDraftJobs(new Map(((flows ?? []) as Array<FlowJob & { id: string }>).map((job) => [String(job.id), job])));
      } else setDraftJobs(new Map());
    } catch (err) {
      setLoadError(friendlyError(err, "Couldn't load invoices."));
      setRows(DEMO_MODE ? await loadDemoInvoices() : []);
      loaded = null;
    } finally {
      setLoading(false);
      setBacklogKey((key) => key + 1);
    }
    return loaded;
  }, []);
  useEffect(() => { void loadInvoices(); }, [loadInvoices]);
  useEffect(() => {
    if (!supabase) return;
    void supabase.rpc("customer_credit").then(({ data }) => {
      const rows = (data ?? []) as Array<{ credit: number }>;
      setCreditHeld({ total: rows.reduce((sum, row) => sum + Math.round(Number(row.credit) * 100), 0) / 100, customers: rows.length });
    });
  }, [rows]);

  useEffect(() => {
    let cancelled = false;
    setViewLines([]);
    setViewAddress([]);
    setViewMobile("");
    setViewError(null);
    if (viewingInvoice && has073) void resolveCustomer(viewingInvoice.customer).then((customer) => { if (!cancelled) setViewMobile(customer?.mobile ?? ""); });
    if (viewingInvoice) {
      fetchInvoiceLines(viewingInvoice)
        .then((lines) => { if (!cancelled) setViewLines(lines); })
        .catch((err) => { if (!cancelled) setViewError(friendlyError(err, "Couldn't load the line items.")); });
      const recorded = issuedBillTo(viewingInvoice.customerSnapshot, viewingInvoice.customer);
      if (recorded) setViewAddress(recorded);
      else void resolveCustomerAddress(viewingInvoice.customer).then((lines) => { if (!cancelled) setViewAddress(lines); });
    }
    return () => { cancelled = true; };
  }, [viewingInvoice, has073]);

  // After a reload: an attempt whose outcome was unknown is looked up by its request id before anything can be sent again.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const id of attempts.uncertainIds()) {
        const attempt = attempts.get(id);
        if (!attempt || !supabase) continue;
        const { outcome } = await findPaymentOutcome(id, attempt.requestId);
        if (cancelled || !outcome) continue;
        attempts.done(id);
        toast.info("A payment that was being saved when the page closed had been recorded.");
        void loadInvoices();
      }
    })();
    return () => { cancelled = true; };
  }, [attempts, loadInvoices]);

  // The payment history of the invoice on screen (invoice_payments, migration 032), newest last.
  useEffect(() => {
    let cancelled = false;
    setPayments([]);
    setPaymentsLoaded(false);
    setPaymentsError(null);
    // Never an endless "Loading payments…": a read that hasn't settled in time says so (an answer that comes later still counts).
    const giveUp = window.setTimeout(() => { if (!cancelled) setPaymentsError("Couldn't load the payments. Reload the page to try again."); }, PAYMENTS_READ_TIMEOUT_MS);
    if (viewingInvoice?.id && supabase) {
      void supabase.from("invoice_payments").select("*").eq("invoice_id", viewingInvoice.id).order("created_at").order("id").then(({ data, error }) => {
        if (cancelled) return;
        window.clearTimeout(giveUp);
        if (error) setPaymentsError(friendlyError(error, "Couldn't load the payments."));
        else {
          setPayments((data ?? []).map((row) => paymentFromRow(row as Record<string, unknown>)));
          setPaymentsError(null);
          setPaymentsLoaded(true);
        }
      });
    } else window.clearTimeout(giveUp);
    return () => { cancelled = true; window.clearTimeout(giveUp); };
  }, [viewingInvoice?.id, paymentsVersion]);

  useEffect(() => {
    if (!viewingInvoice || memberNames.size || !supabase) return;
    void supabase.rpc("org_members").then(({ data }) => {
      const names = new Map<string, string>();
      for (const member of (data ?? []) as Array<{ user_id: string; full_name?: string | null; email?: string | null }>) names.set(member.user_id, member.full_name || member.email || "");
      setMemberNames(names);
    });
  }, [viewingInvoice, memberNames.size]);

  useEffect(() => {
    if (!dueTouched) setFormDue(addDays(formDate || today, termsDays(formTerms)));
  }, [formDate, formTerms, dueTouched, today]);

  // Open / Done / Archived (lib/archive, migration 028): finished records move out of the way; nothing is deleted.
  const archive = useArchive("invoices");
  const [phase, setPhase] = useState<PhaseFilterValue>("open");
  // /invoices?filter=overdue|draft-old (the dashboard's "View all"): only those invoices, whatever Show says.
  const [listFilter, clearListFilter] = useListFilter("invoices");
  const phaseFor = useCallback((invoice: (typeof invoices)[number]) => phaseOf({ final: ["paid", "void", "cancelled"].includes(invoice.status), finalDate: invoice.paidAt || invoice.date }, invoice.id ? archive.manual.get(String(invoice.id)) : undefined, archive.months), [archive.manual, archive.months]);
  // Open drafts of any age (archived ones are not waiting), and how many are over 2 days old (the dashboard counts only those).
  const drafts = useMemo(() => draftInvoiceCounts(invoices, today, (invoice) => phaseFor(invoice) === "archived"), [invoices, today, phaseFor]);
  const draftsWaiting = drafts.total;
  const phaseCounts = useMemo(() => ({ open: invoices.filter((x) => phaseFor(x) === "open").length, done: invoices.filter((x) => phaseFor(x) === "done").length, archived: invoices.filter((x) => phaseFor(x) === "archived").length }), [invoices, phaseFor]);
  const visibleInvoices = useMemo(() => invoices.filter((invoice) => (listFilter ? invoiceMatchesFilter(listFilter, invoice, today, phaseFor(invoice) === "archived") : (phase === "all" || phaseFor(invoice) === phase) && (filters.has("all") || filters.has(invoice.status) || (filters.has("partial") && invoice.partPaid)))), [filters, invoices, listFilter, phase, phaseFor, today]);
  // Collectible invoices only (no drafts, void or cancelled), counted at what is still owed.
  const unpaid = useMemo(() => invoices.filter((invoice) => invoice.status === "overdue" || invoice.status === "outstanding"), [invoices]);
  const totalOwed = useMemo(() => fromPence(unpaid.reduce((sum, invoice) => sum + toPence(invoice.balance), 0)), [unpaid]);
  const aging = useMemo(() => AGING.map((bucket) => ({ ...bucket, value: fromPence(unpaid.filter((invoice) => bucket.test(invoice.daysOverdue)).reduce((sum, invoice) => sum + toPence(invoice.balance), 0)) })), [unpaid]);
  const overdueInvoices = useMemo(() => invoices.filter((invoice) => invoice.status === "overdue"), [invoices]);

  // Customers with overdue invoices, worst first, computed from the loaded invoices.
  const latePayers = useMemo(() => {
    const byCustomer = new Map<string, { overdue: InvoiceRow[]; total: number; owed: number }>();
    for (const invoice of invoices) {
      const entry = byCustomer.get(invoice.customer) ?? { overdue: [], total: 0, owed: 0 };
      entry.total += 1;
      if (invoice.status === "overdue") {
        entry.overdue.push(invoice);
        entry.owed += invoice.balance;
      }
      byCustomer.set(invoice.customer, entry);
    }
    return [...byCustomer.entries()]
      .filter(([, entry]) => entry.overdue.length)
      .map(([customer, entry]) => {
        const avgDays = Math.round(entry.overdue.reduce((sum, invoice) => sum + invoice.daysOverdue, 0) / entry.overdue.length);
        const worst = Math.max(...entry.overdue.map((invoice) => invoice.daysOverdue));
        return { customer, label: worst > 60 ? "CHRONIC" : "WATCH", color: worst > 60 ? "bg-red-600" : "bg-amber-500", late: `${entry.overdue.length}/${entry.total} overdue`, avg: `avg ${avgDays} days late`, owed: entry.owed, worst };
      })
      .sort((a, b) => b.worst - a.worst)
      .slice(0, 3);
  }, [invoices]);

  // Invoicing trends for the chosen date range, from real invoice and payment dates.
  const trends = useMemo(() => {
    // Raised = issued in the range (drafts, void and cancelled are not raised); paid on time = lib/receivables paidOnTime.
    const inRange = invoices.filter((invoice) => invoice.date && invoice.date >= trendRange.from && invoice.date <= trendRange.to && isRaised(invoice.rawStatus));
    const paid = inRange.filter((invoice) => invoice.status === "paid" && invoice.paidAt && invoice.dueDate);
    const onTime = paidOnTime(inRange.map((invoice) => ({ status: invoice.rawStatus, payment_unverified: invoice.paymentUnverified, due_date: invoice.dueDate ?? null, paid_at: invoice.paidAt ?? null })));
    const lateDays = [
      ...paid.map((invoice) => Math.max(0, daysBetween(toDateInput(invoice.paidAt), invoice.dueDate as string))).filter((days) => days > 0),
      ...inRange.filter((invoice) => invoice.status === "overdue").map((invoice) => invoice.daysOverdue),
    ];
    return {
      raised: inRange.length,
      onTime: onTime.rate === null ? "—" : `${onTime.rate}%`,
      onTimeOf: paidOnTimeNote(onTime),
      avgLate: lateDays.length ? String(Math.round(lateDays.reduce((a, b) => a + b, 0) / lateDays.length)) : "—",
    };
  }, [invoices, trendRange]);

  const viewLineItems = viewLines;
  // The invoice's own VAT settings and the company as issued (snapshot): the same inputs and rules as its PDF (audit A3).
  const { showVat: viewVat, totals: viewTotals } = invoiceDisplayTotals(viewingInvoice ?? { carriage: 0, vatEnabled: false, carriageVat: false, rawStatus: "draft" }, viewLineItems, company);
  // Lines that don't add up to the stored totals (imported records): show the stored total and why it can't print.
  const viewProblem = viewingInvoice && viewLineItems.length && company ? invoiceTotalsProblem(viewingInvoice, viewLineItems, invoiceIssuer(viewingInvoice, company)) : null;
  // Create form: live preview of what will be saved.
  const formVatOn = vat.registered && (formVat ?? true);
  const formLineVat = fromVatChoice(formVatChoice ?? vat.defaultChoice);
  const formTotals = documentTotals([
    { quantity: Number(formQty) || 0, unitPrice: Number(formUnit) || 0, ...formLineVat },
    ...extraLines.map((line) => ({ quantity: Number(line.qty) || 0, unitPrice: Number(line.unit) || 0, ...fromVatChoice(line.vat) })),
  ], Number(formCarriage) || 0,
    { vatEnabled: formVatOn, carriageVat: true, standardRate: vat.standardRate });
  // CSV / Excel / Word / PDF: the selected invoices if any, otherwise every invoice in the current filter. CSV / Excel use the import column spec, not the display columns.
  const exportScope = exportScopeRows(invoices.filter((invoice) => selectedInvoices.includes(invoice.reference)), visibleInvoices);
  const scopeTitle = exportScopeTitle("invoice", selectedInvoices.length, visibleInvoices.length);
  const paymentsTitle = selectedInvoices.length ? `Exports the payments of the ${selectedInvoices.length} selected invoice${selectedInvoices.length === 1 ? "" : "s"}` : "Exports every payment recorded on every invoice (nothing is selected)";
  const selectedInvoiceRows = exportScope.map((invoice) => ({
    Invoice: shownInvoiceRef(invoice),
    Customer: invoice.customer,
    Amount: currency(invoice.amount),
    Paid: currency(invoice.amountPaid),
    "Balance Due": currency(invoice.balance),
    Status: invoice.status,
    "Due Date": fmtDate(invoice.dueDate),
    "Days Overdue": invoice.daysOverdue > 0 ? invoice.daysOverdue : 0,
  }));

  /** Payments CSV / Excel: those of the selected invoices if any, otherwise every payment (paid invoices are not in the default Open list, so the filter isn't used). */
  async function exportPayments(format: "csv" | "xlsx") {
    if (!supabase) return;
    try {
      const { rows, truncated } = await fetchAll((from, to) => supabase!.from("invoice_payments").select("*").order("created_at").order("id").range(from, to));
      if (truncated) {
        toast.error("There are too many payments to export in one go. Select some invoices and export those.");
        return;
      }
      const scope = selectedInvoices.length ? invoices.filter((invoice) => selectedInvoices.includes(invoice.reference)) : invoices;
      await exportSpreadsheet(format, "Invoice Payments", PAYMENT_COLUMNS, paymentExportRows(scope, rows.map(paymentFromRow)), "invoices");
    } catch (err) {
      toast.error(friendlyError(err, "Couldn't load the payments to export."));
    }
  }

  async function createInvoice(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    await run(async () => {
      try {
        if (!supabase) throw new Error("Supabase is not configured.");
        const profile = await requireCompanyProfile();
        const input = parseOrThrow(invoiceSaveSchema, {
          customer: String(form.get("customer") || ""),
          invoiceDate: String(form.get("invoice_date") || ""),
          dueDate: String(form.get("due_date") || ""),
          taxPoint: String(form.get("tax_point") || ""),
          terms: String(form.get("terms") || profile.defaultInvoiceTerms),
          quoteRef: String(form.get("quote_ref") || ""),
          customerPo: String(form.get("customer_po") || ""),
          carriage: Number(form.get("carriage") || 0),
          lines: [
            { description: String(form.get("description") || ""), quantity: Number(form.get("quantity")), unitPrice: Number(form.get("unit_price")) },
            ...extraLines.map((extra) => ({ description: extra.description, quantity: extra.qty.trim() === "" ? Number.NaN : Number(extra.qty), unitPrice: extra.unit.trim() === "" ? Number.NaN : Number(extra.unit) })),
          ],
        });
        if (input.dueDate < input.invoiceDate) throw new ValidationError("The due date can't be before the invoice date.");
        const line = input.lines[0];
        // Stored total includes carriage (taxed at the standard rate when VAT is on), and matches the preview and the PDF.
        const vatOn = profile.vatRegistered !== false && (formVat ?? true);
        const lineVats = [fromVatChoice(formVatChoice ?? companyVat(profile).defaultChoice), ...extraLines.map((extra) => fromVatChoice(extra.vat))];
        const totals = documentTotals(input.lines.map((l, i) => ({ quantity: l.quantity, unitPrice: l.unitPrice, ...lineVats[i] })), input.carriage,
          { vatEnabled: vatOn, carriageVat: true, standardRate: profile.defaultVatRate });
        // A draft: no number yet. Issuing gives it the next INV number (issue_invoice, migration 027).
        // create_with_lines files it in the session's company: refused if another tab switched it since this page opened (S5).
        await confirmPageCompany(supabase);
        const { data: newId, error } = await supabase.rpc("create_with_lines", {
          p_parent: "invoices",
          p_header: {
            customer: input.customer,
            description: line.description,
            quantity: line.quantity,
            unit_price: line.unitPrice,
            subtotal: totals.subtotal,
            carriage: totals.carriage,
            vat: totals.vat,
            total: totals.total,
            vat_enabled: vatOn,
            carriage_vat: vatOn,
            invoice_date: input.invoiceDate,
            terms: input.terms || profile.defaultInvoiceTerms,
            quote_ref: input.quoteRef || null,
            customer_po: input.customerPo || null,
            ...(formJob ? { job_id: formJob.id } : {}),
            due_date: input.dueDate,
            // Only when it differs from the invoice date; fixed once the invoice is issued.
            tax_point: input.taxPoint && input.taxPoint !== input.invoiceDate ? input.taxPoint : null,
            status: "draft",
            amount_paid: 0,
          },
          p_child: "invoice_line_items",
          p_fk: "invoice_id",
          p_lines: input.lines.map((l, position) => ({ position, description: l.description, quantity: l.quantity, unit_price: l.unitPrice, vat_pct: lineVats[position].vatPct, vat_exempt: lineVats[position].vatExempt })),
        });
        if (error) throw error;
        void auditEvent({ action: "CREATE", entityTable: "invoices", entityId: String(newId) });
        toast.success("Draft invoice saved. Check it, then issue it to give it a number.");
        // Reset and close only after a successful save.
        formEl.reset();
        setFormCustomer("");
        setFormQuoteRef("");
        setFormCustomerPo("");
        setFormJob(null);
        setFormTerms(profile.defaultInvoiceTerms);
        setFormDate(today);
        setDueTouched(false);
        setFormVat(null);
        setFormVatChoice(null);
        setFormQty("1");
        setFormUnit("");
        setExtraLines([]);
        setFormCarriage("0");
        setOpen(false);
        void loadInvoices();
      } catch (err) {
        toast.error(userMessage(err, "Could not save the invoice. Nothing was saved."));
      }
    });
  }

  /** Opens the payment dialog for one invoice: the amount starts as the balance due, the date as today. */
  function openPayment(invoice: InvoiceRow) {
    const blocked = paymentBlockedReason(invoice.rawStatus);
    if (blocked) {
      toast.error(blocked);
      return;
    }
    // An earlier attempt on this invoice (outcome unknown, or refused) comes back with the same values; it is checked on submit.
    const prior = attempts.get(invoice.id ?? invoice.reference);
    setPayAmount(prior?.amount ?? balanceDue(invoice.amount, invoice.amountPaid, invoice.credited, invoice.refunded).toFixed(2));
    setPayDate(prior?.paidOn ?? today);
    setPayMethod(prior?.method ?? "BACS");
    setPayReference(prior?.reference ?? "");
    setPayUncertain(prior?.state === "sent");
    setPayError(prior?.state === "sent" ? UNCERTAIN_MESSAGE : null);
    setPayOpenedAt(Date.now());
    setPaymentFor(invoice);
  }

  /**
   * Records one payment through record_invoice_payment (migration 032): the database locks the invoice, checks the
   * balance, writes the payment, sets the amount paid and status (Part paid, then Paid) and the audit entry in one
   * transaction. The screen is updated from what it answers, never from a guess.
   */
  async function submitPayment(invoice: InvoiceRow, input: { amount: number; paidOn: string; method: string | null; reference: string | null; requestId: string }) {
    if (!supabase || !invoice.id) {
      if (!DEMO_MODE) throw new Error("Supabase is not configured.");
      const paidTotal = fromPence(toPence(invoice.amountPaid) + toPence(input.amount));
      const settled = toPence(paidTotal) >= toPence(invoice.amount);
      setRows((current) => current.map((item) => item.reference === invoice.reference ? { ...item, amountPaid: paidTotal, rawStatus: settled ? "paid" : "partial", paidAt: settled ? nowIso() : undefined } : item));
      return { status: settled ? "paid" : "partial", balance: balanceDue(invoice.amount, paidTotal, invoice.credited, invoice.refunded), amountPaid: paidTotal };
    }
    const { data, error } = await supabase.rpc("record_invoice_payment", { p_request_id: input.requestId, p_invoice: invoice.id, p_amount: input.amount, p_paid_on: input.paidOn, p_method: input.method, p_reference: input.reference });
    if (error) throw error;
    const result = data as { status: string; amount_paid: number; balance_due: number };
    setRows((current) => current.map((item) => item.id === invoice.id
      ? { ...item, amountPaid: Number(result.amount_paid), rawStatus: result.status, paidAt: result.status === "paid" ? `${input.paidOn}T12:00:00Z` : undefined }
      : item));
    return { status: result.status, balance: Number(result.balance_due), amountPaid: Number(result.amount_paid) };
  }

  /** Editing the amount or date drops the last check's message (e.g. "more than the balance due"); recordPayment checks again on submit. The "can't confirm it was saved" notice stays: editing doesn't answer it. */
  function clearPayProblem() {
    setPayError((current) => (current === UNCERTAIN_MESSAGE ? current : null));
  }

  /** The dialog's "Record payment" button. */
  async function recordPayment() {
    const invoice = paymentFor;
    if (!invoice) return;
    if (saving) return;
    const amount = Number(payAmount);
    // Exact pennies: what is typed must be pounds and at most two decimals; nothing is rounded-none for the person.
    const problem = !/^\d+(\.\d{1,2})?$/.test(payAmount.trim()) ? "Enter the amount in pounds and pence (two decimal places at most)." : paymentAmountProblem(amount, balanceDue(invoice.amount, invoice.amountPaid, invoice.credited, invoice.refunded)) ?? paymentDateProblem(payDate, today);
    if (problem) { setPayError(problem); return; }
    setPayError(null);
    await run(async () => {
      const key = invoice.id ?? invoice.reference;
      let result: PaymentOutcome;
      let recovered = false;
      if (!supabase || !invoice.id) {
        try {
          result = await submitPayment(invoice, { amount, paidOn: payDate, method: payMethod || null, reference: payReference.trim() || null, requestId: crypto.randomUUID() });
        } catch (err) {
          setPayError(userMessage(err, "Could not record the payment. Nothing was saved."));
          return;
        }
      } else {
        const client = supabase;
        const outcome = await recordWithRecovery(key, { amount: payAmount.trim(), paidOn: payDate, method: payMethod, reference: payReference.trim() }, attempts, {
          record: async (attempt) => {
            const { data, error } = await client.rpc("record_invoice_payment", { p_request_id: attempt.requestId, p_invoice: invoice.id, p_amount: Number(attempt.amount), p_paid_on: attempt.paidOn, p_method: attempt.method || null, p_reference: attempt.reference || null });
            if (error) return { outcome: null, error };
            const r = data as { status: string; amount_paid: number; balance_due: number };
            return { outcome: { status: r.status, amountPaid: Number(r.amount_paid), balance: Number(r.balance_due) }, error: null };
          },
          find: (requestId) => findPaymentOutcome(String(invoice.id), requestId),
        }, () => crypto.randomUUID(), payOpenedAt);
        if (outcome.kind === "stale") {
          setPayUncertain(false);
          setPayError(outcome.error.message);
          void loadInvoices();
          return;
        }
        if (outcome.kind === "no-lock") {
          setPayUncertain(false);
          setPayError(outcome.error.message);
          return;
        }
        if (outcome.kind === "not-saved") {
          // Nothing was sent: without a saved record a lost answer could be sent twice.
          setPayUncertain(false);
          setPayError(outcome.error.message);
          return;
        }
        if (outcome.kind === "refused") {
          setPayUncertain(false);
          setPayError(userMessage(outcome.error, "Could not record the payment. Nothing was saved."));
          return;
        }
        if (outcome.kind === "unknown") {
          console.error(outcome.error);
          setAttemptsVersion((n) => n + 1);
          setPayUncertain(true);
          setPayError(UNCERTAIN_MESSAGE);
          return;
        }
        result = outcome.outcome;
        recovered = outcome.recovered;
        setRows((current) => current.map((item) => item.id === invoice.id ? { ...item, amountPaid: result.amountPaid, rawStatus: result.status, paidAt: result.status === "paid" ? `${payDate}T12:00:00Z` : undefined } : item));
        if (recovered) void loadInvoices();
      }
      setPayUncertain(false);
      setAttemptsVersion((n) => n + 1);
      setPaymentFor(null);
      setSelectedInvoices([]);
      setPaymentsVersion((n) => n + 1);
      const received = recovered ? "" : ` - ${currency(amount)} received`;
      if (result.status === "paid") {
        setViewingInvoice(null);
        setFilters(new Set(["paid"]));
        setPhase("done"); // it moved to Done: show it there
        toast.success(`${invoice.reference} paid in full${received}`);
      } else {
        setViewingInvoice((current) => current && current.reference === invoice.reference ? derive({ ...current, amountPaid: result.amountPaid, rawStatus: result.status }, today) : current);
        toast.success(recovered ? `The payment on ${invoice.reference} had been saved. Part paid: ${currency(result.balance)} still to pay.` : `${currency(amount)} recorded on ${invoice.reference}. Part paid: ${currency(result.balance)} still to pay.`);
      }
    });
  }

  /** Pays each listed invoice's balance in full, today, one payment each (so each has its own history and audit entry). */
  async function payInFull(references: string[]) {
    const invoicesToPay = invoices.filter((invoice) => references.includes(invoice.reference) && (invoice.status === "overdue" || invoice.status === "outstanding" || invoice.status === "unverified"));
    if (invoicesToPay.length === 0) {
      toast.info("Selected invoices are already paid");
      setSelectedInvoices([]);
      return;
    }
    await run(async () => {
      const succeeded: InvoiceRow[] = [];
      let failure: unknown = null;
      let unknown = 0;
      const client = supabase;
      const settle = (invoice: InvoiceRow, outcome: PaymentOutcome) => {
        succeeded.push(invoice);
        setRows((current) => current.map((item) => item.id === invoice.id ? { ...item, amountPaid: outcome.amountPaid, rawStatus: outcome.status, paidAt: outcome.status === "paid" ? `${today}T12:00:00Z` : undefined } : item));
      };
      // Without a database (demo) there is no answer to lose; with one, every invoice has its own registered attempt.
      const live = invoicesToPay.filter((invoice) => client && invoice.id);
      for (const invoice of invoicesToPay.filter((invoice) => !live.includes(invoice))) {
        try {
          await submitPayment(invoice, { amount: balanceDue(invoice.amount, invoice.amountPaid, invoice.credited, invoice.refunded), paidOn: today, method: null, reference: null, requestId: crypto.randomUUID() });
          succeeded.push(invoice);
        } catch (err) {
          failure = err;
        }
      }
      const byId = new Map(live.map((invoice) => [String(invoice.id), invoice]));
      const results = await recordBatch(live.map((invoice) => ({ id: String(invoice.id), values: { amount: balanceDue(invoice.amount, invoice.amountPaid, invoice.credited, invoice.refunded).toFixed(2), paidOn: today, method: "", reference: "" } })), attempts, (id) => ({
        record: async (attempt) => {
          const { data, error } = await client!.rpc("record_invoice_payment", { p_request_id: attempt.requestId, p_invoice: id, p_amount: Number(attempt.amount), p_paid_on: attempt.paidOn, p_method: attempt.method || null, p_reference: attempt.reference || null });
          if (error) return { outcome: null, error };
          const r = data as { status: string; amount_paid: number; balance_due: number };
          return { outcome: { status: r.status, amountPaid: Number(r.amount_paid), balance: Number(r.balance_due) }, error: null };
        },
        find: (requestId) => findPaymentOutcome(id, requestId),
      }), () => crypto.randomUUID(), Date.now());
      for (const { id, result } of results) {
        const invoice = byId.get(id)!;
        if (result.kind === "done") settle(invoice, result.outcome);
        else if (result.kind === "unknown") { console.error(result.error); unknown += 1; }
        else failure = result.error; // refused, or nothing was sent: definitely not saved
      }
      setAttemptsVersion((n) => n + 1);
      if (succeeded.length) {
        const totalPaid = fromPence(succeeded.reduce((sum, invoice) => sum + toPence(balanceDue(invoice.amount, invoice.amountPaid, invoice.credited, invoice.refunded)), 0));
        setSelectedInvoices([]);
        setViewingInvoice(null);
        setFilters(new Set(["paid"]));
        setPhase("done"); // they moved to Done: show them there
        setPaymentsVersion((n) => n + 1);
        toast.success(`${succeeded.length} invoice${succeeded.length === 1 ? "" : "s"} paid in full - ${currency(totalPaid)}`);
      }
      if (unknown) toast.error(`${unknown} invoice${unknown === 1 ? "" : "s"} could not be confirmed: a payment may have been saved. Use Check and save on each one.`);
      if (failure) toast.error(succeeded.length || unknown ? `${invoicesToPay.length - succeeded.length - unknown} invoice(s) could not be updated. ${userMessage(failure)}` : userMessage(failure, "Could not record the payment."));
    });
  }

  /** Reverses one recorded payment (admin): a negative row with the reason, never a delete. */
  async function reversePayment() {
    const payment = reversing;
    const invoice = viewingInvoice;
    if (!payment || !invoice?.id || !supabase) return;
    if (!reverseReason.trim()) { setReverseTried(true); return; }
    await run(async () => {
      try {
        const { data, error } = await supabase!.rpc("reverse_invoice_payment", { p_payment: payment.id, p_reason: reverseReason.trim() });
        if (error) throw error;
        const result = data as { status: string; amount_paid: number };
        const updated = { amountPaid: Number(result.amount_paid), rawStatus: result.status, paidAt: result.status === "paid" ? invoice.paidAt : undefined };
        setRows((current) => current.map((item) => item.id === invoice.id ? { ...item, ...updated } : item));
        setViewingInvoice((current) => current && current.id === invoice.id ? derive({ ...current, ...updated }, today) : current);
        setPaymentsVersion((n) => n + 1);
        setReversing(null);
        setReverseReason("");
        setReverseTried(false);
        toast.success(`Payment of ${currency(payment.amount)} reversed on ${invoice.reference}`);
      } catch (err) {
        toast.error(userMessage(err, "Could not reverse the payment. Nothing was changed."));
      }
    });
  }

  /** After a credit was applied (migration 034): reads the invoice's receipts and credits back, so the list and the details agree. */
  async function refreshCredits(invoice: InvoiceRow) {
    if (!supabase || !invoice.id) return;
    const { data } = await supabase.from("invoices").select("status, amount_paid, credited_amount, refunded_amount, paid_at").eq("id", invoice.id).single();
    if (!data) return;
    const updated = { amountPaid: Number(data.amount_paid || 0), credited: Number(data.credited_amount || 0), refunded: Number(data.refunded_amount || 0), rawStatus: invoiceStatus(data.status), paidAt: data.paid_at ? String(data.paid_at) : undefined };
    setRows((current) => current.map((item) => (item.id === invoice.id ? { ...item, ...updated } : item)));
    setViewingInvoice((current) => (current && current.id === invoice.id ? derive({ ...current, ...updated }, today) : current));
  }

  /** Drafts a chaser email in email_history for each overdue invoice whose customer has an email address. */
  async function chaseOverdue() {
    if (!overdueInvoices.length) {
      toast.info("No overdue invoices to chase.");
      return;
    }
    await run(async () => {
      try {
        if (!supabase) throw new Error("Supabase is not configured.");
        const profile = await requireCompanyProfile();
        const organizationId = await getCurrentOrganizationId();
        const { data: userData } = await supabase.auth.getUser();
        const customers = await fetchCustomers();
        const withIds = overdueInvoices.filter((invoice) => invoice.id);
        const { data: existing, error: existingError } = await supabase.from("email_history").select("related_to_id").eq("related_to_type", "invoice").eq("status", "drafted").in("related_to_id", withIds.map((invoice) => invoice.id as string));
        if (existingError) throw existingError;
        const alreadyDrafted = new Set((existing ?? []).map((row) => String(row.related_to_id)));
        let noEmail = 0;
        const drafts = [];
        // The company's own reminder text (Settings > Email templates), or the default when none is saved or 106 isn't applied.
        const override = await loadTemplateOverride(supabase, "invoice_reminder");
        for (const invoice of withIds) {
          if (alreadyDrafted.has(invoice.id as string)) continue;
          const customer = findCustomer(customers, invoice.customer);
          if (!customer?.email) { noEmail += 1; continue; }
          const email = renderTemplate("invoice_reminder", invoiceReminderVars({
            reference: invoice.reference, total: currency(invoice.amount), dueDate: fmtDate(invoice.dueDate), daysOverdue: invoice.daysOverdue,
            companyName: profile.name, customerName: customer.name, contactName: customer.contactName,
            amountPaid: invoice.amountPaid, paidText: currency(invoice.amountPaid), balanceText: currency(invoice.balance),
          }), override);
          drafts.push({
            organization_id: organizationId,
            to_email: customer.email,
            to_name: customer.contactName || customer.name,
            subject: email.subject,
            body: email.text,
            status: "drafted",
            related_to_type: "invoice",
            related_to_id: invoice.id,
            drafted_by: userData.user?.id ?? null,
            drafted_at: nowIso(),
          });
        }
        if (drafts.length) {
          const { error } = await supabase.from("email_history").insert(drafts);
          if (error) throw error;
          void auditEvent({ action: "DRAFT_CHASERS", entityTable: "email_history", metadata: { count: drafts.length } });
        }
        const skipped = alreadyDrafted.size + noEmail;
        toast.success(drafts.length ? `${drafts.length} chaser email${drafts.length === 1 ? "" : "s"} drafted. Review them in the Approval Queue.${skipped ? ` ${skipped} skipped (already drafted or no customer email).` : ""}` : `Nothing new to draft. ${skipped} skipped (already drafted or no customer email).`);
      } catch (err) {
        toast.error(userMessage(err, "Could not draft the chaser emails."));
      }
    });
  }

  async function buildInvoicePdf(invoice: InvoiceRow, currentProfile: CompanyProfile) {
    const lines = await fetchInvoiceLines(invoice);
    if (!lines.length) throw new ValidationError("This invoice has no line items, so there is nothing to print.");
    // Issued: print the details recorded at issue, not today's. A draft prints with today's (lib/invoice-totals).
    const profile = invoiceIssuer(invoice, currentProfile);
    // The lines must add up to the stored totals, or the PDF would show amounts that weren't invoiced.
    const problem = invoiceTotalsProblem(invoice, lines, profile);
    if (problem) throw problem;
    const billTo = issuedBillTo(invoice.customerSnapshot, invoice.customer) ?? await resolveCustomerAddress(invoice.customer);
    // The notes on this invoice itself; a failed lookup leaves the line off rather than stopping the PDF.
    const ownNotes = invoice.id && supabase ? await fetchInvoiceNotes(supabase, { id: invoice.id }).catch((): InvoiceNote[] => []) : [];
    const deliveryNotes = deliveryNotesPrintedLine(ownNotes);
    // The customer sign-off (072) of the job those notes are on, when there is one; none (or 072 not applied) leaves the invoice as it was.
    const customerSignOff = supabase && ownNotes.length ? await invoiceCustomerSignOff(supabase, ownNotes) : undefined;
    return (
      <InvoicePDF
        data={{
          deliveryNotes,
          customerSignOff,
          storedTotals: invoiceStoredTotals(invoice),
          number: invoice.reference,
          date: fmtDate(invoice.date ?? nowIso()),
          taxPoint: invoice.taxPoint ? fmtDate(invoice.taxPoint) : undefined,
          terms: invoice.terms || profile.defaultInvoiceTerms,
          quoteRef: invoice.quoteRef,
          customerPo: invoice.customerPo,
          billTo,
          deliverTo: deliveryAddressLines(invoice.deliveryAddress),
          note: invoice.invoiceNote ?? undefined,
          lineItems: lines,
          carriage: invoice.carriage,
          vatEnabled: invoice.vatEnabled,
          carriageVat: invoice.carriageVat,
          // Only a known amount is printed: never the invoice total in place of a payment nobody recorded.
          ...invoicePdfPayments({ status: invoice.rawStatus, amount_paid: invoice.amountPaid, payment_unverified: invoice.paymentUnverified }),
          ...invoicePdfCredits({ credited_amount: invoice.credited, refunded_amount: invoice.refunded, total: invoice.amount, amount_paid: invoice.amountPaid }, currentProfile),
          company: profile,
        }}
      />
    );
  }

  async function downloadInvoicePdf(invoice: InvoiceRow) {
    await downloadPdf(async () => buildInvoicePdf(invoice, await requireCompanyProfile()), `invoice-${invoice.reference}.pdf`, { entityTable: "invoices", entityId: invoice.reference });
  }

  /**
   * Opens an email draft to the customer and downloads the PDF to attach ("Send to Customer"; recording it as sent is a separate
   * step), or, with `oneClick` ("Email now"), the send dialog: sent from here with the PDF attached, the sent date recorded once it has gone.
   */
  async function sendInvoice(invoice: InvoiceRow, oneClick = false) {
    await run(async () => {
      try {
        const profile = await requireCompanyProfile();
        const element = await buildInvoicePdf(invoice, profile);
        const customer = await resolveCustomer(invoice.customer);
        if (!customer?.email) toast.info(`No email address on file for ${invoice.customer}. Add one on the Customers page, or type it into the email.`);
        // The old way (also the "Open in my mail app" link): the person's own mail app, the PDF downloaded to attach, then "has it gone?".
        const mailApp = async (subject: string, body: string) => {
          openMailDraft(customer?.email ?? "", subject, body);
          const ok = await downloadPdf(element, `invoice-${invoice.reference}.pdf`, { entityTable: "invoices", entityId: invoice.reference }, { silent: true });
          if (!ok) return;
          toast.success("PDF downloaded \u2014 attach it to the email that just opened");
          setSendConfirm(invoice);
        };
        if (!oneClick || !invoice.id || DEMO_MODE) {
          const email = renderTemplate("invoice", invoiceEmailVars(invoice, profile.name), await loadTemplateOverride(supabase, "invoice"));
          await mailApp(email.subject, email.text);
          return;
        }
        // One-click send (E8): the dialog sends it with the PDF attached; once it has gone, the sent date is recorded.
        setEmailRequest({
          kind: "invoice", recordId: invoice.id, templateKey: "invoice", to: customer?.email, vars: invoiceEmailVars(invoice, profile.name),
          pdf: { filename: `invoice-${invoice.reference}.pdf`, build: () => pdfBlob(element) },
          onOpenMailApp: (subject, body) => { setEmailRequest(null); void mailApp(subject, body); },
          onSent: () => void confirmInvoiceSent(invoice),
        });
      } catch (err) {
        toast.error(err instanceof ValidationError ? err.message : pdfErrorMessage(err));
      }
    });
  }

  /** Staff confirmed the e-mail went: records when (sent_date). Issuing is separate and already happened. */
  async function confirmInvoiceSent(invoice: InvoiceRow) {
    await run(async () => {
      try {
        if (invoice.rawStatus === "draft") throw new ValidationError("Issue the invoice before sending it.");
        const sentAt = nowIso();
        if (supabase && invoice.id) {
          const { error } = await supabase.from("invoices").update({ sent_date: sentAt }).eq("id", invoice.id);
          if (error) throw error;
        } else if (!DEMO_MODE) {
          throw new Error("Supabase is not configured.");
        }
        setRows((current) => current.map((item) => item.reference === invoice.reference ? { ...item, sentAt } : item));
        setViewingInvoice((current) => current && current.reference === invoice.reference ? { ...current, sentAt } : current);
        void auditEvent({ action: "SEND", entityTable: "invoices", entityId: invoice.reference });
        setSendConfirm(null);
        toast.success(`${invoice.reference} recorded as sent`);
      } catch (err) {
        toast.error(friendlyError(err, "Couldn't record the invoice as sent."));
      }
    });
  }

  /** An admin confirms the payments recorded on an imported invoice are all there are (migration 032): it then counts as owed for its balance. */
  async function confirmPayments() {
    const invoice = confirmFor;
    if (!invoice) return;
    await run(async () => {
      try {
        if (!supabase || !invoice.id) throw new ValidationError("This invoice isn't saved.");
        const { error } = await supabase.rpc("confirm_invoice_payments", { p_invoice: invoice.id, p_note: confirmNote });
        if (error) throw error;
        setRows((current) => current.map((item) => item.id === invoice.id ? { ...item, paymentUnverified: false } : item));
        setConfirmFor(null);
        setConfirmNote("");
        setViewingInvoice(null);
        toast.success(`${invoice.reference}: payments confirmed, now counted as owed for the balance`);
      } catch (err) {
        toast.error(userMessage(err, "Couldn't confirm the payments."));
      }
    });
  }

  /** Draft -> issued: the next INV number, issuer/customer details recorded, contents fixed (migration 027). */
  async function issueInvoice(invoice: InvoiceRow, thenSend = false) {
    const issued = await run(async (): Promise<InvoiceRow | null> => {
      try {
        if (!supabase || !invoice.id) throw new ValidationError("Save the invoice before issuing it.");
        const { data: ref, error } = await supabase.rpc("issue_invoice", { p_invoice: invoice.id });
        if (error) throw error;
        nudgeIntegrationSend("invoice", invoice.id);
        setIssueConfirm(null);
        // The invoice stays open and is shown as now stored (number, issuer and customer details), so "Send to Customer" is there at once.
        const stored = (await loadInvoices())?.find((row) => row.id === invoice.id);
        const shown = stored ? derive(stored, today) : null;
        setViewingInvoice((current) => (current && current.id === invoice.id ? shown : current));
        toast.success(`Invoice ${String(ref)} issued. It now counts as money owed.`);
        return shown;
      } catch (err) {
        toast.error(friendlyError(err, "Couldn't issue the invoice."));
        return null;
      }
    });
    // "Issue & send": only once the invoice is issued and read back, and after the issuing has finished (one action at a time).
    if (thenSend && issued) await sendInvoice(issued);
  }

  /** Drafts can be thrown away (they have no number yet); issued invoices can't (019). */
  async function deleteDraftInvoice(invoice: InvoiceRow) {
    setDeleteDraftConfirm(null);
    await run(async () => {
      try {
        if (!supabase || !invoice.id || invoice.rawStatus !== "draft") throw new ValidationError("Only draft invoices can be deleted.");
        const { data: deleted, error } = await supabase.from("invoices").delete().eq("id", invoice.id).eq("status", "draft").select("id");
        if (error) throw error;
        if (!deletedOne(deleted)) {
          // Nothing was deleted: it was issued (or removed) by someone else first. Show what it is now, never "deleted".
          setViewingInvoice(null);
          await loadInvoices();
          toast.error("This invoice changed before it could be deleted. It may have been issued. The list is refreshed.");
          return;
        }
        setRows((current) => current.filter((item) => item.id !== invoice.id));
        setViewingInvoice(null);
        toast.success("Draft deleted");
      } catch (err) {
        toast.error(friendlyError(err, "Couldn't delete the draft."));
      }
    });
  }

  return (
    <RoleGate allowed={["admin", "office"]}>
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="page-title">Invoicing</h1>
          <p className="mt-2 text-sm text-slate-500">Invoices are what customers owe us. See what is unpaid and chase it.</p>
          {draftsWaiting > 0 ? <p className="mt-1 text-sm font-medium text-ink" data-testid="drafts-waiting" title={`${drafts.old} over ${DRAFT_INVOICE_DAYS} days old (what the dashboard counts). A draft has no number and isn't owed until a person issues it.`}>Drafts waiting to issue: {draftsWaiting}</p> : null}
          {creditHeld.total > 0 ? <p className="mt-1 text-sm font-medium text-amber-800" data-testid="customer-credit-held" title="Open an invoice with credit to refund it or apply it to another invoice.">Customer credit held: {currency(creditHeld.total)} for {creditHeld.customers} customer{creditHeld.customers === 1 ? "" : "s"}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className={overdueInvoices.length ? "border-amber-500 bg-amber-500 text-[#1c1917] hover:border-amber-400 hover:bg-amber-400" : undefined} disabled={saving || loading || !overdueInvoices.length} onClick={() => void chaseOverdue()} title={overdueInvoices.length ? "Draft a chaser email for every overdue invoice" : "No overdue invoices"}>
            <Send className="size-4" /> Chase All Overdue
          </Button>
          <Button variant="outline" onClick={() => setFromNotesOpen(true)}>Invoice from Delivery Notes</Button>
          <ColumnToggle tableKey="invoices" /><Button type="button" variant="outline" size="sm" className="min-h-9" aria-pressed={compact} onClick={() => setCompact(!compact)}>Compact list</Button><ViewSwitcher value={view} onChange={setView} />
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button className="bg-brand text-brand-ink hover:bg-brand-hover"><Plus className="size-4" /> New invoice</Button>
            </DialogTrigger>
            <DialogContent className="max-w-3xl">
              <DialogHeader>
                <DialogTitle>Create Invoice</DialogTitle>
                <DialogDescription>Enter the invoice details. With VAT on, the line is taxed at its rate and carriage at the standard rate.</DialogDescription>
              </DialogHeader>
              <form onSubmit={createInvoice} className="grid gap-4">
                <div className="grid gap-3 md:grid-cols-2">
                  <CustomerSelect name="customer" required value={formCustomer} onValueChange={changeFormCustomer} />
                  <JobPicker name="job" selected={formJob} active={open} includeInternal={false} valueIs="id" emptyLabel="Job (optional): fills the customer, quote and PO" onPick={pickFormJob} />
                  <label className="grid gap-1 text-xs text-slate-500">Invoice date<Input name="invoice_date" type="date" required value={formDate} onChange={(event) => setFormDate(event.target.value)} /></label>
                  <label className="grid gap-1 text-xs text-slate-500">Due date<Input name="due_date" type="date" required value={formDue} onChange={(event) => { setDueTouched(true); setFormDue(event.target.value); }} /></label>
                  <label className="grid gap-1 text-xs text-slate-500">Terms<select name="terms" value={formTerms} onChange={(event) => setFormTerms(event.target.value)} className="h-9 rounded-lg border border-slate-300 px-3 text-sm text-slate-950"><option>30 days</option><option>14 days</option><option>Due on receipt</option></select></label>
                  <Input name="quote_ref" maxLength={50} placeholder="Our quote no. (QUO-0123)" value={formQuoteRef} onChange={(event) => setFormQuoteRef(event.target.value)} />
                  <Input name="customer_po" maxLength={100} placeholder="Customer order no." value={formCustomerPo} onChange={(event) => setFormCustomerPo(event.target.value)} />
                  <label className="grid gap-1 text-xs text-slate-500">Tax point (only if different from the invoice date)<Input name="tax_point" type="date" /></label>
                </div>
                <Textarea name="description" placeholder="Description" maxLength={500} required />
                <div className="grid gap-3 md:grid-cols-3">
                  <label className="grid gap-1 text-xs text-slate-500">Quantity<Input name="quantity" type="number" step="0.001" min="0" inputMode="decimal" placeholder="Quantity" value={formQty} onChange={(event) => setFormQty(event.target.value)} required /></label>
                  <label className="grid gap-1 text-xs text-slate-500">Unit price (ex VAT)<Input name="unit_price" type="number" step="0.01" min="0" inputMode="decimal" placeholder="0.00" value={formUnit} onChange={(event) => setFormUnit(event.target.value)} required /></label>
                  <label className="grid gap-1 text-xs text-slate-500">Carriage (ex VAT)<Input name="carriage" type="number" step="0.01" min="0" inputMode="decimal" placeholder="0.00" value={formCarriage} onChange={(event) => setFormCarriage(event.target.value)} /></label>
                </div>
                {extraLines.map((extra, index) => (
                  <div key={index} className="grid gap-2 rounded-lg border border-slate-200 p-3 md:grid-cols-[1fr_100px_120px_100px_40px]">
                    <Input aria-label={`Line ${index + 2} description`} maxLength={500} placeholder="Description" value={extra.description} onChange={(event) => setExtraLines((rows) => rows.map((row, i) => i === index ? { ...row, description: event.target.value } : row))} />
                    <Input aria-label={`Line ${index + 2} quantity`} type="number" step="0.001" min="0" inputMode="decimal" placeholder="Qty" value={extra.qty} onChange={(event) => setExtraLines((rows) => rows.map((row, i) => i === index ? { ...row, qty: event.target.value } : row))} />
                    <Input aria-label={`Line ${index + 2} unit price`} type="number" step="0.01" min="0" inputMode="decimal" placeholder="0.00" value={extra.unit} onChange={(event) => setExtraLines((rows) => rows.map((row, i) => i === index ? { ...row, unit: event.target.value } : row))} />
                    <VatRateSelect label={`Line ${index + 2} VAT rate`} value={extra.vat} disabled={!formVatOn} onChange={(choice) => setExtraLines((rows) => rows.map((row, i) => i === index ? { ...row, vat: choice } : row))} />
                    <Button type="button" variant="ghost" size="icon" aria-label={`Remove line ${index + 2}`} onClick={() => setExtraLines((rows) => rows.filter((_, i) => i !== index))}><Trash2 className="size-4" /></Button>
                  </div>
                ))}
                <Button type="button" variant="outline" className="w-fit" onClick={() => setExtraLines((rows) => [...rows, { description: "", qty: "1", unit: "", vat: vat.defaultChoice }])}>Add another line</Button>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-2">
                    <VatToggle registered={vat.registered} checked={formVatOn} onChange={setFormVat} />
                    {vat.registered ? <label className="flex items-center gap-2 text-xs text-slate-500">{extraLines.length ? "First line VAT" : "Line VAT"}<VatRateSelect value={formVatChoice ?? vat.defaultChoice} disabled={!formVatOn} onChange={setFormVatChoice} /></label> : null}
                  </div>
                  <VatTotals totals={formTotals} vatEnabled={formVatOn} showCarriage className="w-full max-w-xs space-y-1 rounded-lg bg-slate-50 p-4 text-sm" />
                </div>
                <Button type="submit" disabled={saving} className="bg-brand text-brand-ink hover:bg-brand-hover">{saving ? "Saving…" : "Save Invoice"}</Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {DEMO_MODE ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Demo mode: sample data is shown if the database can&apos;t be reached.</div> : null}

      <Card className="overflow-hidden">
        <CardContent className="grid gap-4 p-6 lg:grid-cols-[1.2fr_2fr]">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-ink"><Banknote className="size-5 text-muted-foreground" /> Money Dashboard</div>
            <div className={`mt-4 text-5xl font-semibold tabular-nums tracking-tight ${overdueInvoices.length ? "text-red-600" : "text-ink"}`}>{loading ? "—" : currency(totalOwed)}</div>
            <p className="mt-2 text-sm text-slate-600">{loading ? "Loading…" : `Across ${unpaid.length} outstanding invoice${unpaid.length === 1 ? "" : "s"}`}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {aging.map(({ label, value, color }) => (
              <Card key={label} className="cursor-pointer transition hover:bg-canvas" onClick={() => setFilters(new Set(label === "Current" ? ["outstanding"] : ["overdue"]))}>
                <CardContent className="p-4">
                  <p className="text-xs font-medium text-slate-500">{label}</p>
                  <p className={`mt-2 text-xl font-semibold tabular-nums ${value > 0 ? color : "text-ink"}`}>{loading ? "—" : currency(value)}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><TrendingDown className="size-5 text-amber-600" /> Late Payer Patterns</CardTitle></CardHeader>
        <CardContent className="grid gap-3 lg:grid-cols-3">
          {loading ? <Skeleton className="h-20" /> : latePayers.length ? latePayers.map((payer) => (
            <div key={payer.customer} className="rounded-lg border border-slate-200 p-4">
              <Badge className={`${payer.color} text-white`}>{payer.label}</Badge>
              <p className="mt-3 font-semibold text-slate-950">{payer.customer}</p>
              <p className="mt-1 text-sm text-slate-500">{payer.late} · {payer.avg} · {currency(payer.owed)} owed</p>
            </div>
          )) : <p className="text-sm text-slate-500 lg:col-span-3">No customers have overdue invoices.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Invoicing Trends</CardTitle></CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
          <DateRangeFields from={trendRange.from} to={trendRange.to} onApply={setTrendRange} />
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border p-4"><p className="field-label">Invoices Raised</p><p className="mt-2 text-2xl font-bold">{loading ? "—" : trends.raised}</p><p className="mt-1 text-xs text-slate-500" data-testid="raised-caption">{raisedCaption(trendRange.from, trendRange.to)}</p></div>
            <div className="rounded-lg border p-4"><p className="field-label">Paid On Time</p><p className="mt-2 text-2xl font-bold text-green-700" data-testid="paid-on-time">{loading ? "—" : trends.onTime}</p><p className="mt-1 text-xs text-slate-500" data-testid="paid-on-time-note">{loading ? "" : trends.onTimeOf}</p></div>
            <div className="rounded-lg border p-4"><p className="field-label">Avg Days Late</p><p className="mt-2 text-2xl font-bold text-amber-700">{loading ? "—" : trends.avgLate}</p></div>
          </div>
        </CardContent>
      </Card>

      {listFilter ? <ListFilterNotice label={INVOICE_FILTER_LABELS[listFilter] ?? listFilter} onClear={clearListFilter} /> : null}
      <PhaseFilter value={phase} onChange={(next) => { setPhase(next); setFilters((current) => chipsForPhase(current, next)); }} counts={phaseCounts} note={INVOICE_SHOW_NOTE} />
        <FilterBar
        activeValues={[...filters]}
        options={[
          { label: "All", value: "all" },
          { label: "Overdue", value: "overdue" },
          { label: "Outstanding", value: "outstanding" },
          { label: "Part paid", value: "partial" },
          { label: "Paid", value: "paid" },
          { label: "Draft / void", value: "closed" },
        ]}
        onChange={setFilters}
      />
      <ListToolbar
        visibleCount={visibleInvoices.length}
        selectedCount={selectedInvoices.length}
        onSelectAll={() => setSelectedInvoices(visibleInvoices.map((invoice) => invoice.reference))}
        onClear={() => setSelectedInvoices([])}
        exports={[
          { label: "CSV", title: scopeTitle, onSelect: () => void exportSpreadsheet("csv", "Invoices", INVOICE_COLUMNS, exportScope, "invoices") },
          { label: "Excel", title: scopeTitle, onSelect: () => void exportSpreadsheet("xlsx", "Invoices", INVOICE_COLUMNS, exportScope, "invoices") },
          { label: "Payments CSV", title: paymentsTitle, onSelect: () => void exportPayments("csv") },
          { label: "Payments Excel", title: paymentsTitle, onSelect: () => void exportPayments("xlsx") },
          { label: "Word", title: scopeTitle, onSelect: () => void exportRows("word", EXPORT_TITLES.invoices, selectedInvoiceRows, "invoices") },
          { label: "PDF", title: scopeTitle, onSelect: () => void exportRows("pdf", EXPORT_TITLES.invoices, selectedInvoiceRows, "invoices") },
        ]}
        actions={
          <Button variant="outline" disabled={saving} onClick={() => {
            const eligible = invoices.filter((invoice) => selectedInvoices.includes(invoice.reference) && !paymentBlockedReason(invoice.rawStatus) && (invoice.status === "overdue" || invoice.status === "outstanding" || invoice.status === "unverified"));
            const draftsSelected = invoices.some((invoice) => selectedInvoices.includes(invoice.reference) && paymentBlockedReason(invoice.rawStatus));
            if (!selectedInvoices.length) toast.error("Select at least one invoice first");
            else if (!eligible.length) toast.info(draftsSelected ? `None of the selected invoices is waiting for payment. ${DRAFT_PAYMENT_REASON}.` : "None of the selected invoices is waiting for payment");
            else setBulkToPay(eligible);
          }}>{saving ? "Saving…" : "Pay Selected in Full"}</Button>
        }
      />

      {uncertainInvoices.length ? (
        <div role="alert" data-testid="uncertain-payments" className="grid gap-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <span>{UNCERTAIN_MESSAGE}</span>
          {uncertainInvoices.map((invoice) => (
            <div key={invoice.reference} className="flex flex-wrap items-center justify-between gap-3">
              <span className="font-mono">{invoice.reference}</span>
              <Button size="sm" variant="outline" disabled={saving} onClick={() => openPayment(invoice)}>Check and save</Button>
            </div>
          ))}
        </div>
      ) : null}

      {loadError ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <span>{loadError}</span>
          <Button variant="outline" size="sm" onClick={() => void loadInvoices()}>Retry</Button>
        </div>
      ) : null}
      <UninvoicedDeliveryNotes refreshKey={backlogKey} onInvoiceFromNotes={() => setFromNotesOpen(true)} />
      {loading ? (
        <div className="space-y-3"><Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" /></div>
      ) : loadError && !DEMO_MODE ? null : visibleInvoices.length === 0 ? (
        <EmptyList
          title={invoices.length ? "No invoices match this filter" : "No invoices yet"}
          hint={invoices.length ? (phase !== "all" ? `Nothing in Show: ${phase[0].toUpperCase()}${phase.slice(1)} matches this status. Try Show: All, or a different status.` : "Try a different filter.") : invoicesEmptyHint()}
          hintTestId={invoices.length ? undefined : "empty-hint"}
          action={invoices.length ? <Button variant="outline" onClick={() => setFilters(new Set(["all"]))}>Show all</Button> : <Button className="bg-brand text-brand-ink hover:bg-brand-hover" onClick={() => setOpen(true)}><Plus className="size-4" /> New invoice</Button>}
        />
      ) : compact ? (
        <CompactInvoiceList rows={visibleInvoices} onOpen={setViewingInvoice} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table data-view={view}>
              <TableHeader className="hidden md:table-header-group">
                <TableRow><TableHead><SelectBox aria-label={`Select all ${visibleInvoices.length} filtered invoices`} checked={selectedInvoices.length === visibleInvoices.length && visibleInvoices.length > 0} onChange={(event) => setSelectedInvoices(event.target.checked ? visibleInvoices.map((invoice) => invoice.reference) : [])} /></TableHead>{isVisible("invoice") ? <TableHead>Invoice</TableHead> : null}{isVisible("customer") ? <TableHead>Customer</TableHead> : null}{isVisible("status") ? <TableHead>Status</TableHead> : null}{isVisible("amount") ? <TableHead>Amount</TableHead> : null}<TableHead className="text-right">Actions</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {visibleInvoices.map((invoice) => (
                  <TableRow key={invoice.id ?? invoice.reference} className={`block md:table-row ${invoice.status === "paid" ? "opacity-60" : ""}`}>
                    <TableCell className="block md:table-cell"><SelectBox aria-label={`Select ${shownInvoiceRef(invoice)}`} checked={selectedInvoices.includes(invoice.reference)} onChange={() => setSelectedInvoices((current) => current.includes(invoice.reference) ? current.filter((ref) => ref !== invoice.reference) : [...current, invoice.reference])} /></TableCell>
                    {isVisible("invoice") ? <TableCell data-label="Invoice" className="block font-mono font-semibold md:table-cell"><InvoiceRefCell invoice={invoice} autoDraftedFrom={invoice.id ? autoDrafted.get(invoice.id) : null} jobStage={jobDraftStage({ status: invoice.rawStatus, job_id: invoice.jobId }, invoice.jobId ? draftJobs.get(invoice.jobId) : null)} /></TableCell> : null}
                    {isVisible("customer") ? <TableCell data-label="Customer" className="block md:table-cell">{invoice.customer}</TableCell> : null}
                    {isVisible("status") ? <TableCell data-label="Status" className="block md:table-cell">
                      <StatusBadge status={invoiceStatusKey(invoice)} unmapped={{ variant: "outline" }} label={invoice.status === "paid" ? "PAID" : invoice.status === "unverified" ? "PAYMENT TO CONFIRM" : invoice.status === "closed" ? invoice.rawStatus.toUpperCase() : invoice.partPaid ? "PART PAID" : !invoice.dueDate ? "No due date" : invoice.daysOverdue > 0 ? `${invoice.daysOverdue} days overdue` : invoice.daysOverdue === 0 ? "Due today" : `Due in ${Math.abs(invoice.daysOverdue)} days`} />
                      {invoice.partPaid && invoice.dueDate ? <span className="block text-xs text-slate-500">{invoice.daysOverdue > 0 ? `${invoice.daysOverdue} days overdue` : invoice.daysOverdue === 0 ? "Due today" : `Due in ${Math.abs(invoice.daysOverdue)} days`}</span> : null}
                    </TableCell> : null}
                    {isVisible("amount") ? <TableCell data-label="Amount" className="block font-semibold md:table-cell">{currency(invoice.amount)}{invoice.amountPaid > 0 && invoice.balance > 0 ? <span className="block text-xs font-normal text-slate-500">{currency(invoice.amountPaid)} paid{invoice.credited > 0 ? `, ${currency(invoice.credited)} credited` : ""}, {currency(invoice.balance)} still owed</span> : invoice.credited > 0 && invoice.balance > 0 ? <span className="block text-xs font-normal text-slate-500">{currency(invoice.credited)} credited, {currency(invoice.balance)} still owed</span> : null}</TableCell> : null}
                    <TableCell data-actions className="block md:table-cell"><div className="flex flex-wrap items-center gap-2 md:justify-end">
                      <div className="flex shrink-0 items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => setViewingInvoice(invoice)}>View</Button>
                        {archive.canManage ? <ArchiveButton id={invoice.id ? String(invoice.id) : undefined} phase={phaseFor(invoice)} manual={invoice.id ? archive.manual.get(String(invoice.id)) : undefined} onSet={archive.setState} /> : null}
                      </div>
                      {paymentBlockedReason(invoice.rawStatus) ? null : <Button variant="outline" size="sm" disabled={invoice.status === "paid" || invoice.status === "closed" || saving} onClick={() => openPayment(invoice)}>Record payment</Button>}
                    </div></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <Dialog open={Boolean(issueConfirm)} onOpenChange={(nextOpen) => !nextOpen && setIssueConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Issue this invoice to {issueConfirm?.customer}?</DialogTitle>
            <DialogDescription>It gets the next invoice number and its contents are fixed. From then on it counts as money owed, whether or not it has been e-mailed. This can&apos;t be undone.{issueThenSend ? " The e-mail and PDF open straight after; you then confirm it has gone." : ""}</DialogDescription>
          </DialogHeader>
          <AiFinanceCheckPanel kind="invoice" id={issueConfirm?.id} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setIssueConfirm(null)}>Cancel</Button>
            <Button className="bg-brand text-brand-ink hover:bg-brand-hover" disabled={saving} onClick={() => issueConfirm && void issueInvoice(issueConfirm, issueThenSend)}>
              {saving ? "Issuing\u2026" : issueThenSend ? "Issue & send" : "Issue Invoice"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <SendEmailDialog request={emailRequest} onClose={() => setEmailRequest(null)} />
      <Dialog open={Boolean(sendConfirm)} onOpenChange={(nextOpen) => !nextOpen && setSendConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Has {sendConfirm?.reference} gone to the customer?</DialogTitle>
            <DialogDescription>Attach the PDF and send the email first, then record it here.</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setSendConfirm(null)}>Not yet</Button>
            <Button className="bg-brand text-brand-ink hover:bg-brand-hover" disabled={saving} onClick={() => sendConfirm && void confirmInvoiceSent(sendConfirm)}>
              {saving ? "Saving\u2026" : "I\u2019ve sent it"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(paymentFor)} onOpenChange={(nextOpen) => !nextOpen && setPaymentFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record a payment on {paymentFor?.reference}</DialogTitle>
            <DialogDescription>
              {paymentFor ? `Invoice total ${currency(paymentFor.amount)}${paymentFor.amountPaid > 0 ? `, ${currency(paymentFor.amountPaid)} already received` : ""}. Balance due ${currency(balanceDue(paymentFor.amount, paymentFor.amountPaid, paymentFor.credited, paymentFor.refunded))}. The amount starts as the full balance: change it for a part payment.` : ""}
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void recordPayment(); }}>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-xs text-slate-500">Amount received (£)<Input name="payment_amount" type="number" step="0.01" min="0.01" inputMode="decimal" required value={payAmount} onChange={(event) => { setPayAmount(event.target.value); clearPayProblem(); }} /></label>
              <label className="grid gap-1 text-xs text-slate-500">Date received<Input name="payment_date" type="date" required max={today} value={payDate} onChange={(event) => { setPayDate(event.target.value); clearPayProblem(); }} /></label>
              <label className="grid gap-1 text-xs text-slate-500">Method<select name="payment_method" value={payMethod} onChange={(event) => setPayMethod(event.target.value)} className="h-9 rounded-lg border border-slate-300 px-3 text-sm text-slate-950">{PAYMENT_METHODS.map((method) => <option key={method} value={method}>{method === "BACS" ? "BACS" : method[0].toUpperCase() + method.slice(1)}</option>)}</select></label>
              <label className="grid gap-1 text-xs text-slate-500">Reference (optional)<Input name="payment_reference" maxLength={100} placeholder="Cheque no. or bank reference" value={payReference} onChange={(event) => setPayReference(event.target.value)} /></label>
            </div>
            {payError ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{payError}</p> : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setPaymentFor(null)}>Cancel</Button>
              <Button type="button" variant="outline" onClick={() => { if (!paymentFor) return; setPayAmount(balanceDue(paymentFor.amount, paymentFor.amountPaid, paymentFor.credited, paymentFor.refunded).toFixed(2)); clearPayProblem(); }}>Pay balance in full</Button>
              <Button type="submit" className="bg-green-600 text-white hover:bg-green-700" disabled={saving}>{saving ? "Saving…" : payUncertain ? "Check and save" : "Save payment"}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(bulkToPay)} onOpenChange={(nextOpen) => !nextOpen && setBulkToPay(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record {bulkToPay?.length ?? 0} invoice{bulkToPay?.length === 1 ? "" : "s"} as paid in full?</DialogTitle>
            <DialogDescription>
              Records one payment on each, for its whole balance, dated today ({fmtDate(nowIso())}): {currency(fromPence((bulkToPay ?? []).reduce((sum, invoice) => sum + toPence(balanceDue(invoice.amount, invoice.amountPaid, invoice.credited, invoice.refunded)), 0)))} received in total. For a part payment, use Record payment on that invoice.
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-48 space-y-1 overflow-y-auto text-sm" aria-label="Invoices to pay in full">
            {(bulkToPay ?? []).map((invoice) => <li key={invoice.reference} className="flex justify-between gap-3"><span className="font-mono">{invoice.reference}</span><span>{invoice.customer}</span><span>{currency(balanceDue(invoice.amount, invoice.amountPaid, invoice.credited, invoice.refunded))}</span></li>)}
          </ul>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setBulkToPay(null)}>Cancel</Button>
            <Button className="bg-green-600 text-white hover:bg-green-700" disabled={saving} onClick={() => {
              const refs = (bulkToPay ?? []).map((invoice) => invoice.reference);
              setBulkToPay(null);
              void payInFull(refs);
            }}>
              {saving ? "Saving…" : `Confirm ${bulkToPay?.length ?? 0} Paid in Full`}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <InvoiceFromDeliveryNotes open={fromNotesOpen} onClose={() => setFromNotesOpen(false)} terms={company?.defaultInvoiceTerms || formTerms} termsDays={termsDays(company?.defaultInvoiceTerms || formTerms)} onCreated={() => { setFromNotesOpen(false); void loadInvoices(); }} />
      <Dialog open={Boolean(confirmFor)} onOpenChange={(nextOpen) => !nextOpen && setConfirmFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm payments complete on {confirmFor?.reference}?</DialogTitle>
            <DialogDescription>
              {confirmFor ? `You are saying the payments recorded on this invoice (${currency(confirmFor.amountPaid)} so far) are all that has been received, so ${currency(balanceDue(confirmFor.amount, confirmFor.amountPaid, confirmFor.credited, confirmFor.refunded))} is still owed. It then counts as money owed and can be chased. This is recorded in the audit log with your note.` : ""}
            </DialogDescription>
          </DialogHeader>
          <label className="grid gap-1 text-xs text-slate-500">Note (required)<Textarea name="confirm_note" rows={3} maxLength={500} value={confirmNote} onChange={(event) => setConfirmNote(event.target.value)} placeholder="For example: checked against the bank statement" /></label>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmFor(null)}>Cancel</Button>
            <Button className="bg-brand text-brand-ink hover:bg-brand-hover" disabled={saving || !confirmNote.trim()} onClick={() => void confirmPayments()}>{saving ? "Saving…" : "Confirm payments complete"}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(reversing)} onOpenChange={(nextOpen) => { if (!nextOpen) { setReversing(null); setReverseReason(""); setReverseTried(false); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reverse this payment?</DialogTitle>
            <DialogDescription>
              {reversing ? `${currency(reversing.amount)} received ${fmtDate(reversing.paidOn)}${reversing.method ? ` by ${reversing.method}` : ""}. The payment stays in the history, struck through with your reason, and the invoice balance goes back up. This can't be undone; if it was a mistake, record the payment again.` : ""}
            </DialogDescription>
          </DialogHeader>
          <label className="grid gap-1 text-xs text-slate-500">Reason (required)<Textarea name="reverse_reason" rows={3} maxLength={500} value={reverseReason} onChange={(event) => setReverseReason(event.target.value)} placeholder="For example: cheque bounced" aria-invalid={reverseTried && !reverseReason.trim()} /></label>
          {reverseTried && !reverseReason.trim() ? <p role="alert" className="text-sm text-red-700">Give a reason (at least 1 character).</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setReversing(null); setReverseReason(""); setReverseTried(false); }}>Cancel</Button>
            <Button className="bg-red-600 text-white hover:bg-red-700" disabled={saving} onClick={() => void reversePayment()}>{saving ? "Saving…" : "Reverse payment"}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(viewingInvoice)} onOpenChange={(nextOpen) => !nextOpen && setViewingInvoice(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{viewingInvoice ? shownInvoiceRef(viewingInvoice) : ""} invoice details</DialogTitle>
            <DialogDescription>Full customer invoice record and payment status.</DialogDescription>
          </DialogHeader>
          {viewingInvoice ? (
            <div className="space-y-5">
              <div className="grid gap-4 rounded-lg border bg-slate-50 p-4 text-sm md:grid-cols-2">
                <div>
                  <span className="field-label block">Customer</span>
                  <p className="font-semibold text-slate-950">{viewingInvoice.customer}</p>
                  <p className="text-slate-600">{viewAddress.slice(1).join(", ")}</p>
                  {viewMobile ? <p className="text-slate-600">Mobile {viewMobile}</p> : null}
                </div>
                <div>
                  <span className="field-label block">Status</span>
                  <p><StatusBadge status={invoiceStatusKey(viewingInvoice)} label={invoiceDetailStatusLabel(viewingInvoice)} /></p>
                </div>
                <div><span className="field-label block">Invoice Date</span><p className="font-medium text-slate-950">{fmtDate(viewingInvoice.date) || "-"}</p></div>
                <div><span className="field-label block">Due Date</span><p className="font-medium text-slate-950">{fmtDate(viewingInvoice.dueDate) || "-"}{viewingInvoice.status === "overdue" ? ` (${viewingInvoice.daysOverdue} days overdue)` : ""}</p></div>
                <div><span className="field-label block">Payment Terms</span><p className="font-medium text-slate-950">{viewingInvoice.terms || company?.defaultInvoiceTerms || "-"}</p></div>
                {viewingInvoice.quoteRef ? <div><span className="field-label block">Our Quote No.</span><p className="font-mono font-medium text-slate-950">{viewingInvoice.quoteRef}</p></div> : null}
                {viewingInvoice.customerPo ? <div><span className="field-label block">Customer Order No.</span><p className="font-mono font-medium text-slate-950">{viewingInvoice.customerPo}</p></div> : null}
                {viewingInvoice.deliveryAddress ? <div><span className="field-label block">Delivery Address</span><p className="whitespace-pre-line font-medium text-slate-950">{viewingInvoice.deliveryAddress}</p></div> : null}
                {viewingInvoice.invoiceNote ? <div className="sm:col-span-2"><span className="field-label block">Invoice Note</span><p className="font-medium text-slate-950">{viewingInvoice.invoiceNote}</p></div> : null}
                {viewingInvoice.status === "paid" && viewingInvoice.amountPaid <= 0 ? <div><span className="field-label block">Paid</span><p className="font-medium text-slate-950">Marked paid; the amount received was never recorded</p></div>
                  : viewingInvoice.amountPaid > 0 ? <div><span className="field-label block">Paid</span><p className="font-medium text-slate-950">{currency(viewingInvoice.amountPaid)} received{viewingInvoice.status === "paid" && viewingInvoice.paidAt ? `, settled ${fmtDate(viewingInvoice.paidAt)}` : ""}{viewingInvoice.paymentUnverified ? "; payment to confirm" : viewingInvoice.partPaid ? `; balance due ${currency(viewingInvoice.balance)}` : ""}</p></div> : null}
              </div>

              {viewError ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{viewError}</div> : null}
              <Table>
                <TableHeader><TableRow><TableHead>Description</TableHead><TableHead>Qty</TableHead><TableHead>Unit Price</TableHead><TableHead>Total</TableHead></TableRow></TableHeader>
                <TableBody>
                  {viewLineItems.length ? viewLineItems.map((item, index) => (
                    isTextLine(item) ? (
                      <TableRow key={`${item.description}-${index}`} data-testid="text-line">
                        <TableCell className="whitespace-pre-line italic" colSpan={4}>{item.description}</TableCell>
                      </TableRow>
                    ) : (
                    <TableRow key={`${item.description}-${index}`}>
                      <TableCell className="whitespace-pre-line">{item.description}</TableCell>
                      <TableCell>{item.quantity}</TableCell>
                      <TableCell>{currency(item.unitPrice)}</TableCell>
                      <TableCell>{currency(documentTotals([{ quantity: item.quantity, unitPrice: item.unitPrice, vatPct: 0 }]).subtotal)}</TableCell>
                    </TableRow>
                    )
                  )) : (
                    <TableRow><TableCell colSpan={4} className="text-slate-500">{viewError ? "Line items unavailable." : "No line items recorded for this invoice."}</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>

              <div className="ml-auto w-full max-w-xs space-y-1 rounded-lg bg-slate-50 p-4 text-sm">
                {viewLineItems.length && !viewProblem ? (
                  <>
                    <VatTotals totals={viewTotals} vatEnabled={viewVat} className="space-y-1" />
                  </>
                ) : (
                  <div className="flex justify-between font-bold"><span>Invoice total</span><span>{currency(viewingInvoice.amount)}</span></div>
                )}
              </div>

              {viewProblem ? <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">{viewProblem.message}</div> : null}
              {viewingInvoice.id ? <InvoiceDeliveryNoteFiles invoiceId={viewingInvoice.id} /> : null}
              {viewingInvoice.id && viewingInvoice.rawStatus === "draft" ? (
                <DraftInvoiceEditor
                  open={editingDraft}
                  invoice={{ ...viewingInvoice, id: viewingInvoice.id }}
                  lines={viewLineItems}
                  vat={{ vatEnabled: viewingInvoice.vatEnabled, carriageVat: viewingInvoice.carriageVat, registered: vat.registered, standardRate: vat.standardRate }}
                  defaultVat={vat.defaultChoice}
                  textLines={has073}
                  onClose={() => setEditingDraft(false)}
                  onSaved={() => { const savedId = viewingInvoice.id ?? null; setEditingDraft(false); void loadInvoices().then((loaded) => { if (loaded) setReopenId(savedId); else setViewingInvoice(null); }); }}
                />
              ) : null}
              {viewingInvoice.rawStatus !== "draft" ? (
                <section aria-label="Payments" className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-slate-950">Payments</h3>
                    {viewingInvoice.status === "overdue" || viewingInvoice.status === "outstanding" ? <Button size="sm" className="bg-green-600 text-white hover:bg-green-700" disabled={saving} onClick={() => openPayment(viewingInvoice)}>Record payment</Button> : null}
                  </div>
                  {paymentsError ? <p role="alert" className="text-sm text-red-700">{paymentsError}</p> : null}
                  {payments.filter((payment) => !payment.reversesPaymentId).length ? (
                    <ul className="divide-y rounded-lg border text-sm" aria-label="Payment history">
                      {payments.filter((payment) => !payment.reversesPaymentId).map((payment) => {
                        const reversal = payments.find((other) => other.reversesPaymentId === payment.id);
                        const who = payment.createdBy ? memberNames.get(payment.createdBy) : "";
                        return (
                          <li key={payment.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3" data-testid="payment-row">
                            <span className={`flex flex-wrap items-center gap-x-4 gap-y-1 ${reversal ? "text-slate-400 line-through" : "text-slate-950"}`}>
                              <span className="w-24">{payment.paidOn ? fmtDate(payment.paidOn) : "Date not recorded"}</span>
                              <span className="w-24 font-semibold">{currency(payment.amount)}</span>
                              <span>{payment.method || (payment.source === "legacy" ? "Carried over" : "")}</span>
                              <span>{payment.reference}</span>
                              {who ? <span>{who}</span> : null}
                            </span>
                            {reversal ? <span className="text-xs text-red-700">Reversed {fmtDate(reversal.paidOn)}: {reversal.voidReason}</span> : null}
                            {isAdmin && !reversal && payment.source === "recorded" ? <Button variant="outline" size="sm" className="ml-auto" disabled={saving} onClick={() => setReversing(payment)}>Reverse</Button> : null}
                          </li>
                        );
                      })}
                    </ul>
                  ) : paymentsError ? null : <p className="text-sm text-slate-500">{paymentsEmptyText({ loaded: paymentsLoaded, status: viewingInvoice.status, amountPaid: viewingInvoice.amountPaid })}</p>}
                  {viewingInvoice.credited > 0 ? <p className="text-sm text-slate-600">Credits applied {currency(viewingInvoice.credited)}, balance due {currency(viewingInvoice.balance)}.</p> : null}
                  {payments.length ? <p className="text-sm text-slate-600">Received so far {currency(netPaid(payments))}{viewingInvoice.balance > 0 ? `, balance due ${currency(viewingInvoice.balance)}` : ""}.</p> : null}
                </section>
              ) : null}
              {viewingInvoice.id && customerCredit({ status: viewingInvoice.rawStatus, total: viewingInvoice.amount, amount_paid: viewingInvoice.amountPaid, credited_amount: viewingInvoice.credited, refunded_amount: viewingInvoice.refunded, payment_unverified: viewingInvoice.paymentUnverified }) > 0 ? (
                <CustomerCreditPanel key={`credit-${viewingInvoice.id}-${viewingInvoice.credited}-${viewingInvoice.refunded}`} invoice={{ id: viewingInvoice.id, reference: viewingInvoice.reference, customer: viewingInvoice.customer }}
                  credit={customerCredit({ status: viewingInvoice.rawStatus, total: viewingInvoice.amount, amount_paid: viewingInvoice.amountPaid, credited_amount: viewingInvoice.credited, refunded_amount: viewingInvoice.refunded })}
                  isAdmin={isAdmin} onChanged={() => { void refreshCredits(viewingInvoice); void loadInvoices(); }} />
              ) : null}
              {viewingInvoice.id ? <InvoiceDeliveryNotes key={`dn-${viewingInvoice.id}`} invoiceId={viewingInvoice.id} jobId={viewingInvoice.jobId} /> : null}
              {viewingInvoice.rawStatus !== "draft" && viewingInvoice.id ? (
                <CreditNotesPanel key={viewingInvoice.id} invoice={{ id: viewingInvoice.id, reference: viewingInvoice.reference, customer: viewingInvoice.customer, vatEnabled: viewingInvoice.vatEnabled, rawStatus: viewingInvoice.rawStatus }} onChanged={() => { void refreshCredits(viewingInvoice); void loadInvoices(); }} />
              ) : null}
              {viewingInvoice.status === "unverified" ? (
                <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
                  <span className="mr-auto">Imported without payment details. Check your records: record each payment you find, then confirm the payments are complete (with none recorded, that it is still owed in full). Recording a payment does not settle that by itself. Until you confirm, it isn&apos;t counted as money owed or chased.</span>
                  {isAdmin ? <Button variant="outline" disabled={saving} onClick={() => { setConfirmNote(""); setConfirmFor(viewingInvoice); }}>Confirm Still Owed</Button> : null}
                  <Button className="bg-green-600 text-white hover:bg-green-700" disabled={saving} onClick={() => openPayment(viewingInvoice)}>Record payment</Button>
                </div>
              ) : null}
              {viewingInvoice.rawStatus === "draft" ? (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <p className="mr-auto text-sm text-slate-600">Draft: no number yet and not money owed. Issue it to give it a number; then it can be printed and sent.</p>
                  <Button variant="outline" disabled={saving} onClick={() => setDeleteDraftConfirm(viewingInvoice)}>Delete Draft</Button>
                  {viewingInvoice.id && !viewError && draftEditAvailable ? <Button variant="outline" disabled={saving} onClick={() => setEditingDraft(true)}>Edit Draft</Button> : null}
                  <Button variant={canIssueAndSend ? "outline" : "default"} className={canIssueAndSend ? "" : "bg-brand text-brand-ink hover:bg-brand-hover"} disabled={saving || Boolean(viewProblem)} onClick={() => { setIssueThenSend(false); setIssueConfirm(viewingInvoice); }}>Issue Invoice</Button>
                  {canIssueAndSend ? <Button className="bg-brand text-brand-ink hover:bg-brand-hover" disabled={saving || Boolean(viewProblem)} onClick={() => { setIssueThenSend(true); setIssueConfirm(viewingInvoice); }}>Issue &amp; send</Button> : null}
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <p className="mr-auto text-sm text-slate-600">{isVoid(viewingInvoice.rawStatus) ? "Void: not owed." : viewingInvoice.sentAt ? `Sent ${fmtDateTime(viewingInvoice.sentAt)}` : "Not recorded as sent yet"}</p>
                  {has073 && viewingInvoice.id && voidOffered(viewingInvoice) ? <Button variant="outline" className="border-red-300 text-red-700 hover:bg-red-50" disabled={saving} onClick={() => setVoidFor(viewingInvoice)}>Void Invoice</Button> : null}
                  <Button variant="outline" disabled={Boolean(viewProblem)} onClick={() => void downloadInvoicePdf(viewingInvoice)}>Download PDF</Button>
                  {viewingInvoice.id && !DEMO_MODE && !isVoid(viewingInvoice.rawStatus) ? <Button variant="outline" disabled={saving || Boolean(viewProblem)} onClick={() => void sendInvoice(viewingInvoice, true)}>Email now</Button> : null}
                  <Button className="bg-brand text-brand-ink hover:bg-brand-hover" disabled={saving || Boolean(viewProblem)} onClick={() => void sendInvoice(viewingInvoice)}>{saving ? "Sending…" : "Send to Customer"}</Button>
                </div>
              )}
            </div>
          ) : null}
        <ActivityPanel table="invoices" recordId={viewingInvoice?.id} className="mt-4" />
      {voidFor?.id ? (
        <VoidInvoiceDialog
          open
          invoice={{ id: voidFor.id, reference: voidFor.reference, customer: voidFor.customer }}
          onClose={() => setVoidFor(null)}
          onVoided={() => { const voidedId = voidFor.id ?? null; setVoidFor(null); void loadInvoices().then((loaded) => { if (loaded) setReopenId(voidedId); else setViewingInvoice(null); }); }}
        />
      ) : null}
      <ConfirmDialog
        open={Boolean(deleteDraftConfirm)}
        title={`Delete this draft invoice for ${deleteDraftConfirm?.customer ?? "the customer"}?`}
        description="The draft has no invoice number yet. Deleting it removes it for good and it cannot be brought back."
        confirmLabel="Delete draft"
        cancelLabel="Keep draft"
        destructive
        busy={saving}
        onCancel={() => setDeleteDraftConfirm(null)}
        onConfirm={() => deleteDraftConfirm && void deleteDraftInvoice(deleteDraftConfirm)}
      />
        </DialogContent>
      </Dialog>
    </div>
    </RoleGate>
  );
}
