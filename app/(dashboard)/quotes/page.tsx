"use client";

import { StatTile } from "@/components/stat-tile";
import { EmptyList } from "@/components/empty-list";
import { quotesEmptyHint } from "@/lib/empty-hints";
import { ActivityPanel } from "@/components/activity-panel";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Download, Eye, Lock, Mail, Paperclip, Plus, Send, Trash2, Upload } from "lucide-react";

import { CostingLinePicker } from "@/components/costing-line-picker";
import { CustomerSelect } from "@/components/customer-select";
import { FilterBar } from "@/components/filter-bar";
import { ColumnToggle } from "@/components/column-toggle";
import { ListToolbar } from "@/components/list-toolbar";
import { ViewSwitcher } from "@/components/view-switcher";
import { useColumnVisibility } from "@/lib/org-settings";
import { ArchiveButton, PhaseFilter } from "@/components/phase-filter";
import { phaseOf, type PhaseFilterValue, useArchive } from "@/lib/archive";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useViewMode } from "@/lib/view-mode";
import { RoleGate } from "@/components/role-gate";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/status-badge";
import { quoteStatusKey } from "@/lib/status-colours";
import { Button } from "@/components/ui/button";
import { SelectBox } from "@/components/ui/select-box";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { storedTotalsProblem } from "@/components/pdf/pdf-totals";
import { auditEvent } from "@/lib/audit";
import { type CompanyProfile, requireCompanyProfile, useCompanyProfile } from "@/lib/company";
import { fetchCustomers, resolveCustomer, resolveCustomerAddress, saveCustomer } from "@/lib/customers";
import { planRfqEmailCarry, rfqQuoteLine } from "@/lib/rfq-quote";
import { DEMO_MODE } from "@/lib/demo";
import { ListFilterNotice, useListFilter } from "@/components/list-filter-notice";
import { QUOTE_FILTER_LABELS, quoteLegend, quoteMatchesFilter } from "@/lib/list-filter";
import { fmtDate, nowIso, toDateInput } from "@/lib/dates";
import { type ExpiredQuoteAction, type ExpiredQuoteCheck, expiredQuoteAuditEvent, expiredQuoteCheck } from "@/lib/quote-expiry";
import { downloadPdf, openMailDraft, pdfBlob, pdfErrorMessage } from "@/lib/download-pdf";
import { type SendEmailRequest, SendEmailDialog } from "@/components/email/send-email-button";
import { renderTemplate } from "@/lib/email/templates/defaults";
import { loadTemplateOverride } from "@/lib/email/templates/store";
import { EXPORT_TITLES, exportRows, exportSpreadsheet } from "@/lib/export-records";
import { QUOTE_COLUMNS } from "@/lib/import-columns";
import { exportScopeRows, exportScopeTitle } from "@/lib/spreadsheet";
import { type QuoteAttachmentReader, type QuoteAttachmentRow, listQuoteAttachments } from "@/lib/quote-attachments";
import { friendlyError } from "@/lib/friendly-error";
import { issuedBillTo, issuedCompany } from "@/lib/document-snapshot";
import { canOfferSend, canRecordDecision, defaultValidUntil, effectiveQuoteStatus, newestFirst, quoteAcceptBlock, quoteFigures, quoteRejectedSendBlock, quoteSendBlock, uploadSummary, quoteValidityDays, type QuoteStatus, storedQuoteStatus } from "@/lib/quote-status";
import { documentTotals, gbp } from "@/lib/money";
import { companyVat, fromVatChoice, toVatChoice, type VatChoice } from "@/lib/vat";
import { VatRateSelect, VatToggle } from "@/components/vat-controls";
import { VatTotals } from "@/components/vat-totals";
import { allocateNumber } from "@/lib/numbering";
import { supabase } from "@/lib/supabase";
import { getCurrentOrganizationId } from "@/lib/supabase-business";
import { useSaving } from "@/lib/use-saving";
import { ValidationError, parseOrThrow, quoteSaveSchema, userMessage } from "@/lib/validation/schemas";
import { fetchAll, truncationNotice } from "@/lib/fetch-all";
import { type AcceptQuoteResult, acceptOutcome, customerPoInput, deliveryDateInput } from "@/lib/accept-quote";
import { CUSTOMER_PO_LABEL, customerPoBeside, customerPoText } from "@/lib/customer-po";
import { databaseHas068 } from "@/lib/db-features";
import { useDatabaseHas068 } from "@/lib/use-database-has-068";
import { readAiDraftNotes } from "@/lib/ai-helper/draft-notes";
import { acceptedLineIds, baseQuoteRef, type DeclinedLineRow, declinedValueByQuote, describedLine, lineReference, partField, versionChain } from "@/lib/quote-versions";


type QuoteRow = {
  id?: string;
  ref: string;
  customer: string;
  value: number;
  /** What to show (expired is derived from validUntil, lib/quote-status). */
  status: QuoteStatus;
  /** What is stored; transitions and writes use this. */
  rawStatus: QuoteStatus;
  /** Customer-facing scope of work (header description). */
  description: string;
  /** Concurrency token for draft correction (replace_draft_quote). */
  updatedAt?: string;
  /** ISO date (YYYY-MM-DD) or "". */
  validUntil: string;
  internalNotes: string;
  customerNotes: string;
  terms: string;
  /** ISO date the quote was issued. */
  date?: string;
  /** ISO timestamp it was last sent. */
  sentAt?: string;
  /** "Add VAT" on this quote (stored; existing quotes had VAT). */
  vatEnabled: boolean;
  /** Issuer / customer details recorded when the quote was created (migration 019); absent on older quotes. */
  issuerSnapshot?: unknown;
  customerSnapshot?: unknown;
  /** 1 for a quote as first made; a revision is the next version (068). ref already carries the suffix ("QUO-0123 v2"). */
  version: number;
  /** The version this one revises. */
  previousVersionId?: string | null;
  /** What its declined lines came to (accepted for part of its lines, 068): the figures count the rest as won. */
  declinedValue?: number;
  /** The customer's own PO (migration 123), shown beside the quote number; "" when there is none. */
  customerPo: string;
};
type QuoteItem = {
  id?: string; description: string; quantity: number; unitPrice: number; source: string; vatPct?: number; vatExempt?: boolean;
  partNumber?: string | null; drawingNumber?: string | null; drawingRevision?: string | null;
  /** Left off the order when the quote was accepted (the customer's PO didn't cover it). */
  declined?: boolean;
};
type BuilderLine = { description: string; qty: number; unit: number; source: string; vat: VatChoice; part: string; drawing: string; rev: string };
type AttachmentRow = QuoteAttachmentRow;

const STATUS_ORDER: QuoteStatus[] = ["draft", "sent", "accepted", "rejected", "expired", "superseded"];
// Full class strings so Tailwind can see them.
const STATUS_STYLES: Record<QuoteStatus, { label: string; border: string; badge: string; bar: string; card: string; text: string }> = {
  draft: { label: "Draft", border: "border-l-slate-400", badge: "bg-slate-100 text-slate-700", bar: "bg-slate-400", card: "border-slate-200 bg-slate-50", text: "text-slate-700" },
  sent: { label: "Sent", border: "border-l-blue-500", badge: "bg-blue-100 text-blue-700", bar: "bg-blue-500", card: "border-blue-200 bg-blue-50", text: "text-blue-700" },
  accepted: { label: "Accepted", border: "border-l-green-500", badge: "bg-green-100 text-green-700", bar: "bg-green-500", card: "border-green-200 bg-green-50", text: "text-green-700" },
  rejected: { label: "Rejected", border: "border-l-red-500", badge: "bg-red-100 text-red-700", bar: "bg-red-500", card: "border-red-200 bg-red-50", text: "text-red-700" },
  expired: { label: "Expired", border: "border-l-yellow-500", badge: "border-yellow-300 bg-yellow-100 text-yellow-900 dark:border-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-100", bar: "bg-yellow-400", card: "border-yellow-200 bg-yellow-50", text: "text-yellow-800 dark:text-yellow-300" },
  superseded: { label: "Superseded", border: "border-l-slate-300", badge: "bg-slate-100 text-slate-500", bar: "bg-slate-300", card: "border-slate-200 bg-slate-50", text: "text-slate-500" },
};
function statusStyle(status: string) {
  return STATUS_STYLES[status as QuoteStatus] ?? STATUS_STYLES.draft;
}

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Demo mode only. JNR's real records are imported lazily so they never ship in the production bundle. */
async function loadDemoQuotes(): Promise<QuoteRow[]> {
  const m = await import("@/lib/jnr-test-data");
  return m.JNR_TEST_QUOTES.map((quote): QuoteRow => ({ ref: quote.ref, customer: quote.customer, value: quote.total, vatEnabled: true, status: quote.status, rawStatus: quote.status, description: "", validUntil: quote.validUntil, internalNotes: "", customerNotes: "", terms: "", date: quote.date, version: 1, customerPo: "" }));
}

async function loadDemoItems(ref: string): Promise<QuoteItem[]> {
  const m = await import("@/lib/jnr-test-data");
  const quote = m.JNR_TEST_QUOTES.find((item) => item.ref === ref);
  return (quote?.lines ?? []).map((line) => ({ description: line.description, quantity: line.quantity, unitPrice: line.unitPrice, source: "manual" }));
}

function currency(value: number) {
  return gbp(value, 2);
}

function formatBytes(bytes: number | null) {
  if (!bytes) return "";
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function QuoteAttachments({ quoteRef }: { quoteRef: string }) {
  const [files, setFiles] = useState<AttachmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  /** The database knows which file is the customer's PO (migration 067); before 067 only plain files can be uploaded. */
  const [poSupported, setPoSupported] = useState(false);
  const poInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setUnavailable(null);
    try {
      if (!supabase) throw new Error("Supabase is not configured.");
      // Before 067 (no kind column) the files are listed as before, with plain uploads only.
      const { files: listed, customerPoSupported } = await listQuoteAttachments(supabase as unknown as QuoteAttachmentReader, quoteRef);
      setPoSupported(customerPoSupported);
      setFiles(listed);
    } catch (err) {
      setFiles([]);
      setUnavailable(`Attachments are not available right now. ${friendlyError(err, "File storage may not be configured.")}`);
    } finally {
      setLoading(false);
    }
  }, [quoteRef]);

  useEffect(() => { void load(); }, [load]);

  async function upload(event: React.ChangeEvent<HTMLInputElement>, kind: "file" | "customer_po" = "file") {
    const input = event.target;
    const picked = Array.from(input.files || []);
    input.value = "";
    if (!picked.length) return;
    setUploading(true);
    try {
      if (!supabase) throw new Error("Supabase is not configured.");
      const organizationId = await getCurrentOrganizationId();
      const { data: userData } = await supabase.auth.getUser();
      const skipped: string[] = [];
      let uploaded = 0;
      for (const file of picked) {
        if (file.size > MAX_ATTACHMENT_BYTES) { skipped.push(file.name); continue; }
        const safeName = file.name.replace(/[^\w.\- ()]+/g, "_");
        let path = `${organizationId}/${quoteRef}/${safeName}`;
        let result = await supabase.storage.from("quote-attachments").upload(path, file, { contentType: file.type || undefined });
        if (result.error && /exists|duplicate/i.test(result.error.message)) {
          path = `${organizationId}/${quoteRef}/${Date.now()}-${safeName}`;
          result = await supabase.storage.from("quote-attachments").upload(path, file, { contentType: file.type || undefined });
        }
        if (result.error) {
          if (/bucket.*not found/i.test(result.error.message)) throw new ValidationError("File storage is not set up yet. Ask an admin to create the quote-attachments bucket.");
          throw result.error;
        }
        const { error } = await supabase.from("quote_attachments").insert({
          organization_id: organizationId,
          quote_ref: quoteRef,
          file_path: path,
          file_name: file.name,
          size_bytes: file.size,
          uploaded_by: userData.user?.id ?? null,
          // The customer's PO travels to the job made from this quote (job pack); plain files keep the default.
          ...(kind === "customer_po" ? { kind } : {}),
        });
        if (error) throw error;
        void auditEvent({ action: "UPLOAD_ATTACHMENT", entityTable: "quote_attachments", entityId: quoteRef, metadata: { file: file.name, size: file.size, kind } });
        uploaded += 1;
      }
      const message = uploadSummary(uploaded, skipped);
      if (uploaded) toast.success(message); else toast.error(message);
      if (uploaded && skipped.length) toast.error(`Not uploaded (over 20 MB): ${skipped.join(", ")}`);
      await load();
    } catch (err) {
      toast.error(userMessage(err, "Could not upload attachment"));
    } finally {
      setUploading(false);
    }
  }

  async function download(file: AttachmentRow) {
    try {
      if (!supabase) throw new Error("Supabase is not configured.");
      const { data, error } = await supabase.storage.from("quote-attachments").createSignedUrl(file.file_path, 60, { download: file.file_name });
      if (error || !data?.signedUrl) throw error ?? new Error("Could not create download link");
      window.open(data.signedUrl, "_blank", "noopener");
      void auditEvent({ action: "DOWNLOAD_ATTACHMENT", entityTable: "quote_attachments", entityId: quoteRef, metadata: { file: file.file_name } });
    } catch (err) {
      toast.error(friendlyError(err, "Could not download attachment"));
    }
  }

  return (
    <div className="space-y-2 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-950"><Paperclip className="size-4" /> Attachments</h3>
        <label className={`inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-3 text-sm font-medium hover:bg-slate-50 ${uploading || unavailable ? "pointer-events-none opacity-50" : ""}`}>
          <Upload className="size-3.5" /> {uploading ? "Uploading..." : "Upload"}
          <input type="file" multiple className="hidden" onChange={(event) => void upload(event)} disabled={uploading || Boolean(unavailable)} />
        </label>
      </div>
      <p className="text-xs text-slate-500">Material lists, certifications and drawings. Stored privately; max 20 MB per file.</p>
      {poSupported ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <span>The customer&apos;s purchase order goes in the job pack: the job made from this quote lists it, and the workshop can open it.</span>
          <input ref={poInput} type="file" aria-label="Customer PO file" className="hidden" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(event) => void upload(event, "customer_po")} disabled={uploading || Boolean(unavailable)} />
          <Button type="button" size="sm" variant="outline" disabled={uploading || Boolean(unavailable)} onClick={() => poInput.current?.click()}><Upload className="size-3.5" /> Upload customer PO</Button>
        </div>
      ) : null}
      {unavailable ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{unavailable}</div> : null}
      {loading ? <Skeleton className="h-10" /> : files.length ? (
        <ul className="divide-y rounded-lg border text-sm">
          {files.map((file) => (
            <li key={file.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="min-w-0 truncate font-medium text-slate-900">{file.kind === "customer_po" ? <Badge variant="outline" className="mr-2 text-xs font-normal">Customer PO</Badge> : null}{file.file_name} <span className="font-normal text-slate-500">{formatBytes(file.size_bytes)}</span></span>
              <Button variant="outline" size="sm" onClick={() => void download(file)}><Download className="size-3.5" /> Download</Button>
            </li>
          ))}
        </ul>
      ) : !unavailable ? <p className="text-sm text-slate-500">No attachments yet.</p> : null}
    </div>
  );
}

const defaultLine = (vat: VatChoice = "20"): BuilderLine => ({ description: "CNC machining", qty: 1, unit: 0, source: "manual", vat, part: "", drawing: "", rev: "" });
/** A line's part / drawing / revision as saved: only the ones filled in (blank = none). */
const linePartFields = (line: BuilderLine | undefined) => Object.fromEntries(
  ([["part_number", line?.part], ["drawing_number", line?.drawing], ["drawing_revision", line?.rev]] as const)
    .map(([key, value]) => [key, partField(value)] as const).filter(([, value]) => value !== null));
/** The same quote (two versions share their number's root, never their id). */
const sameQuote = (a: QuoteRow, b: QuoteRow) => (a.id && b.id ? a.id === b.id : a.ref === b.ref);
const pdfName = (quote: QuoteRow) => `quote-${quote.ref.replace(/\s+/g, "-")}.pdf`;
const lineVat = (line: { vatPct?: number; vatExempt?: boolean }) => ({ vatPct: line.vatPct, vatExempt: line.vatExempt });
/** A row counts once it has a description or a price; a priced row without a description is refused, never dropped. */
const lineInUse = (line: BuilderLine) => line.description.trim() !== "" || Number(line.unit) > 0;

function quoteStoredTotals(quote: QuoteRow) {
  return { reference: quote.ref, issued: quote.rawStatus !== "draft", total: quote.value };
}

// Each line's part, drawing and revision print under its description (one row per part).
const quotePdfLines = (items: QuoteItem[]) => items.map((item) => ({ description: describedLine(item.description, item), quantity: item.quantity, unitPrice: item.unitPrice, ...lineVat(item) }));

/** Why this quote can't be printed from its lines (they don't add up to its stored total), or null. */
function quoteTotalsProblem(quote: QuoteRow, items: QuoteItem[], company: CompanyProfile) {
  return storedTotalsProblem({ lineItems: quotePdfLines(items), showVat: quote.vatEnabled !== false, company, storedTotals: quoteStoredTotals(quote) });
}

/** A draft the AI helper suggested: the "AI-suggested" badge and each "Needs human review" item, read from its internal notes. */
function AiDraftFlags({ notes }: { notes: string }) {
  const flags = readAiDraftNotes(notes);
  if (!flags.aiSuggested) return null;
  return (
    <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm" data-testid="quote-ai-flags">
      <p><span className="rounded bg-violet-100 px-1.5 py-0.5 text-[11px] font-semibold text-violet-800">AI-suggested</span> <span className="text-slate-700">Drafted by the AI helper from an RFQ email and approved by a person. Check it before sending.</span></p>
      {flags.review.length ? (
        <ul className="flex flex-wrap gap-1" aria-label="Needs human review">
          {flags.review.map((item) => <li key={item} className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">Needs human review: {item}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

export default function QuotesPage() {
  const [decision, setDecision] = useState<{ quote: QuoteRow; outcome: "accepted" | "rejected" } | null>(null);
  // Confirm Accepted: the customer's PO when it is already known (optional; without it the sales order gets a provisional number).
  const [decisionPo, setDecisionPo] = useState("");
  // The customer's PO added or changed on the quote itself (set_quote_customer_po, migration 123).
  const [poQuote, setPoQuote] = useState<QuoteRow | null>(null);
  const [poDraft, setPoDraft] = useState("");
  // The date the customer wants it by (optional): the sales order's delivery date, then the job's due date (accept_quote's p_delivery_date).
  const [decisionDue, setDecisionDue] = useState("");
  // Confirm Accepted: the lines the customer's PO doesn't cover (068). Every line is ticked to start; unticked lines go no further.
  const [decisionUnticked, setDecisionUnticked] = useState<Set<string>>(new Set());
  // Revise (068): asked first, "Revise QUO-0123 as v2?".
  const [reviseAsk, setReviseAsk] = useState<QuoteRow | null>(null);
  const router = useRouter();
  // A prepared e-mail waiting for "I've sent it": opening a draft or downloading the PDF doesn't prove it went.
  const [sendConfirm, setSendConfirm] = useState<QuoteRow | null>(null);
  const [emailRequest, setEmailRequest] = useState<SendEmailRequest | null>(null);
  // Asked before anything is prepared (go-live polish 19e): "Send QUO-0005 to buyer@acme.example?", with the date it will be valid until.
  const [sendAsk, setSendAsk] = useState<{ quote: QuoteRow; email: string | null; validUntil: string | null } | null>(null);
  // Asked before Send or Mark accepted on a quote past its valid-until date (lib/quote-expiry): Cancel does nothing, the action goes on as normal.
  const [expiredAsk, setExpiredAsk] = useState<{ quote: QuoteRow; action: ExpiredQuoteAction; check: ExpiredQuoteCheck } | null>(null);
  const { profile: company } = useCompanyProfile();
  const vat = companyVat(company);
  const { saving, run } = useSaving();
  // Quote versions, line choices on acceptance and part details need migration 068; before it the page works as it did.
  const has068 = useDatabaseHas068() === true;
  // null = follow the company setting until the user flips the switch on this quote.
  const [builderVatOn, setBuilderVatOn] = useState<boolean | null>(null);
  // The line made from an RFQ is priced, but (like the blank one) may be made before the company profile has loaded.
  const rfqSeeded = useRef(false);
  const defaultVatRef = useRef<VatChoice>("20");
  const builderVat = vat.registered && (builderVatOn ?? true);
  // The first blank line was created before the company profile loaded: give it the company's default rate.
  useEffect(() => {
    defaultVatRef.current = vat.defaultChoice;
    setLineItems((rows) => rows.length === 1 && (rows[0].unit === 0 || rfqSeeded.current) && rows[0].source === "manual" ? [{ ...rows[0], vat: vat.defaultChoice }] : rows);
  }, [vat.defaultChoice]);
  const [quotes, setQuotes] = useState<QuoteRow[]>([]);
  const [filters, setFilters] = useState(new Set(["all"]));
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lineItems, setLineItems] = useState<BuilderLine[]>([defaultLine()]);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderCustomer, setBuilderCustomer] = useState("");
  /** Builder opened to correct a draft (edit) or to start from an existing quote (copy). */
  const [builderPreset, setBuilderPreset] = useState<{ mode: "edit" | "copy"; quote: QuoteRow } | null>(null);
  const [builderKey, setBuilderKey] = useState(0);
  // Quoting from an RFQ (RFQ page > Quote): the new quote is linked to it, so the RFQ moves to Quoted once sent.
  const [fromRfq, setFromRfq] = useState<{ id: string; customer: string; description: string; email: string } | null>(null);
  useEffect(() => {
    const rfqId = new URLSearchParams(window.location.search).get("rfq");
    if (!rfqId || !supabase) return;
    window.history.replaceState(null, "", window.location.pathname);
    void (async () => {
      const { data } = await supabase!.from("rfqs").select("id, customer, email, description, quantity, estimated_value").eq("id", rfqId).maybeSingle();
      if (!data) return;
      setFromRfq({ id: String(data.id), customer: String(data.customer || ""), description: String(data.description || ""), email: String(data.email || "") });
      setBuilderCustomer(String(data.customer || ""));
      // The RFQ's quantity and value (its total) open as the first line: qty, and unit price = value / qty.
      const rfqLine = rfqQuoteLine(data.quantity, data.estimated_value);
      if (rfqLine) { rfqSeeded.current = true; setLineItems([{ ...defaultLine(defaultVatRef.current), ...rfqLine }]); }
      setBuilderKey((key) => key + 1);
      setBuilderOpen(true);
    })();
  }, []);
  const [viewingQuote, setViewingQuote] = useState<QuoteRow | null>(null);
  const [viewItems, setViewItems] = useState<QuoteItem[]>([]);
  const [viewItemsLoading, setViewItemsLoading] = useState(false);
  const [viewItemsError, setViewItemsError] = useState<string | null>(null);
  // Confirm Accepted: why the ticked lines can't be accepted (they sum to £0.00), shown only where the tick boxes are.
  const acceptedLinesBlock = (() => {
    const lines = viewItems.filter((item) => item.id);
    if (lines.length < 2) return null;
    return quoteAcceptBlock(1, undefined, documentTotals(lines.filter((item) => !decisionUnticked.has(item.id!)).map((item) => ({ quantity: item.quantity, unitPrice: item.unitPrice, vatPct: 0 }))).subtotal);
  })();
  const [selectedRefs, setSelectedRefs] = useState<string[]>([]);
  // A link from elsewhere (RFQ Control's "Open QUO-...") names a quote as /quotes?quote=<id>: once the list has loaded, open that quote (once).
  const linkedQuoteDone = useRef(false);
  useEffect(() => {
    if (linkedQuoteDone.current || loading || !quotes.length) return;
    linkedQuoteDone.current = true;
    const id = new URLSearchParams(window.location.search).get("quote");
    if (!id) return;
    window.history.replaceState(null, "", window.location.pathname);
    const found = quotes.find((quote) => quote.id === id);
    if (found) setViewingQuote(found);
    else toast.info("That quote isn't in your list any more.");
  }, [loading, quotes]);

  const loadQuotes = useCallback(async (): Promise<QuoteRow[]> => {
    setLoading(true);
    setLoadError(null);
    try {
      if (!supabase) throw new Error("Supabase is not configured yet.");
      // Every row, page by page (lib/fetch-all): the API returns at most 1,000 per request.
        const { rows: data, truncated } = await fetchAll((from, to) => supabase!.from("quotes").select("*").order("created_at", { ascending: false }).order("id").range(from, to));
        const error = null;
        if (truncated) toast.warning(truncationNotice(data.length));
      if (error) throw error;
      // Trust the database, including an empty result.
      const rows = ((data ?? []) as Array<Record<string, unknown>>).map((quote): QuoteRow => ({
        id: quote.id ? String(quote.id) : undefined,
        ref: String(quote.quote_ref || ""),
        customer: String(quote.customer || ""),
        value: Number(quote.total_value || 0),
        rawStatus: storedQuoteStatus(quote.status),
        status: effectiveQuoteStatus(storedQuoteStatus(quote.status), quote.valid_until ? String(quote.valid_until) : "", toDateInput(new Date())),
        description: String(quote.description || ""),
        updatedAt: quote.updated_at ? String(quote.updated_at) : undefined,
        validUntil: quote.valid_until ? String(quote.valid_until).slice(0, 10) : "",
        internalNotes: String(quote.internal_notes || ""),
        customerNotes: String(quote.customer_notes || ""),
        terms: String(quote.terms || ""),
        date: quote.created_at ? String(quote.created_at) : undefined,
        sentAt: quote.sent_at ? String(quote.sent_at) : undefined,
        vatEnabled: quote.vat_enabled !== false,
        issuerSnapshot: quote.issuer_snapshot ?? undefined,
        customerSnapshot: quote.customer_snapshot ?? undefined,
        version: Number(quote.version ?? 1) || 1,
        previousVersionId: quote.previous_version_id ? String(quote.previous_version_id) : null,
        customerPo: customerPoText(quote.customer_po ? String(quote.customer_po) : "") ?? "",
      }));
      // Lines left off an accepted quote's order (068), so Accepted counts only what was ordered. Before 068 there are none.
      const { rows: declinedLines, truncated: declinedTruncated } = await databaseHas068()
        ? await fetchAll((from, to) => supabase!.from("quote_line_items").select("quote_id, quantity, unit_price, vat_pct, vat_exempt").eq("declined", true).order("id").range(from, to))
        : { rows: [], truncated: false };
      if (declinedTruncated) toast.warning(truncationNotice(declinedLines.length));
      const vatOn = new Map(rows.map((row) => [row.id ?? "", row.vatEnabled]));
      const declined = declinedValueByQuote(declinedLines as DeclinedLineRow[], (id) => vatOn.get(id) ?? true);
      for (const row of rows) if (row.id && declined.has(row.id)) row.declinedValue = declined.get(row.id);
      setQuotes(rows);
      return rows;
    } catch (err) {
      setLoadError(friendlyError(err, "Couldn't load quotes."));
      setQuotes(DEMO_MODE ? await loadDemoQuotes() : []);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadQuotes(); }, [loadQuotes]);

  async function fetchQuoteItems(quote: QuoteRow): Promise<QuoteItem[]> {
    if (!supabase || !quote.id) return DEMO_MODE ? loadDemoItems(quote.ref) : [];
    // Part / drawing / revision and declined only once 068 is applied; before it, the lines as they were.
    const columns: string = `id, description, quantity, unit_price, source, vat_pct, vat_exempt${await databaseHas068() ? ", part_number, drawing_number, drawing_revision, declined" : ""}`;
    const { data, error } = await supabase.from("quote_line_items").select(columns).eq("quote_id", quote.id).order("position");
    if (error) throw error;
    return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id), description: String(row.description || ""), quantity: Number(row.quantity || 0), unitPrice: Number(row.unit_price || 0), source: String(row.source || "manual"),
      vatPct: row.vat_pct === null || row.vat_pct === undefined ? undefined : Number(row.vat_pct), vatExempt: Boolean(row.vat_exempt),
      partNumber: (row.part_number as string | null | undefined) ?? null, drawingNumber: (row.drawing_number as string | null | undefined) ?? null,
      drawingRevision: (row.drawing_revision as string | null | undefined) ?? null, declined: Boolean(row.declined),
    }));
  }

  useEffect(() => {
    let cancelled = false;
    setViewItems([]);
    setViewItemsError(null);
    if (viewingQuote) {
      setViewItemsLoading(true);
      fetchQuoteItems(viewingQuote)
        .then((items) => { if (!cancelled) setViewItems(items); })
        .catch((err) => { if (!cancelled) setViewItemsError(friendlyError(err, "Couldn't load the line items.")); })
        .finally(() => { if (!cancelled) setViewItemsLoading(false); });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewingQuote]);

  // Open (draft, sent) / Done (accepted, rejected, expired) / Archived (done and old, or archived by hand).
  const archive = useArchive("quotes");
  const [phase, setPhase] = useState<PhaseFilterValue>("open");
  // /quotes?filter=expired|no-decision (the dashboard's "View all"): only those quotes, whatever Show says (an expired quote is "Done").
  const [listFilter, clearListFilter] = useListFilter("quotes");
  const phaseFor = useCallback((quote: QuoteRow) => phaseOf({ final: ["accepted", "rejected", "expired", "superseded"].includes(quote.status), finalDate: quote.validUntil || quote.date }, quote.id ? archive.manual.get(quote.id) : undefined, archive.months), [archive.manual, archive.months]);
  const phaseCounts = useMemo(() => ({ open: quotes.filter((q) => phaseFor(q) === "open").length, done: quotes.filter((q) => phaseFor(q) === "done").length, archived: quotes.filter((q) => phaseFor(q) === "archived").length }), [quotes, phaseFor]);
  // The legend and bar count what the list is scoped to: the dashboard link's filter when there is one (so "Expired (4)" matches the
  // dashboard's 4), else the Show tab (Open / Done / Archived / All). Expired quotes are final, so they are under Done, not Open.
  const legend = useMemo(() => quoteLegend(quotes, listFilter, toDateInput(new Date()), (quote) => phase === "all" || phaseFor(quote) === phase, phase === "all" ? "all quotes" : `${phase[0].toUpperCase()}${phase.slice(1)}`), [listFilter, phase, phaseFor, quotes]);
  const scopeCounts = legend.counts;
  const scopeTotal = STATUS_ORDER.reduce((sum, status) => sum + scopeCounts[status], 0);
  // Newest first everywhere (go-live polish 19a): the list and table in date order; the cards grouped by stage (Drafts, Sent,
  // Accepted, Rejected, Expired) so a quote visibly moves when it is sent or decided, each group newest first.
  const visible = useMemo(() => newestFirst(quotes.filter((quote) => (listFilter ? quoteMatchesFilter(listFilter, quote, toDateInput(new Date())) : (phase === "all" || phaseFor(quote) === phase) && (filters.has("all") || filters.has(quote.status))))), [filters, listFilter, phase, phaseFor, quotes]);
  const groups = useMemo(() => STATUS_ORDER.map((status) => ({ status, items: visible.filter((quote) => quote.status === status) })).filter((group) => group.items.length), [visible]);
  // Cards (default), compact List or full Table, remembered per person (lib/view-mode). Phones always show cards.
  const [view, setView] = useViewMode("quotes", "cards");
  const { isVisible } = useColumnVisibility("quotes");
  // One source of truth for the preview, the saved value and the PDF.
  const builderTotals = useMemo(
    () => documentTotals(lineItems.filter(lineInUse).map((item) => ({ quantity: item.qty, unitPrice: item.unit, ...fromVatChoice(item.vat) })), 0, { vatEnabled: builderVat, standardRate: vat.standardRate }),
    [lineItems, builderVat, vat.standardRate],
  );
  // The same figures as the dashboard (lib/quote-status quoteFigures): Open = sent, still valid, undecided.
  const stats = useMemo(() => quoteFigures(quotes.map((quote) => ({ status: quote.rawStatus, valid_until: quote.validUntil, total_value: quote.value, declined_value: quote.declinedValue ?? 0 })), toDateInput(new Date())), [quotes]);
  // CSV / Excel / Word / PDF: the selected quotes if any, otherwise every quote in the current filter. CSV / Excel use the import column spec, not the display columns.
  const exportScope = exportScopeRows(quotes.filter((quote) => selectedRefs.includes(quote.ref)), visible);
  const scopeTitle = exportScopeTitle("quote", selectedRefs.length, visible.length);
  const selectedRows = exportScope.map((quote) => ({
    "Quote Ref": quote.ref,
    Customer: quote.customer,
    Value: currency(quote.value),
    Status: quote.status,
    "Valid Until": fmtDate(quote.validUntil),
  }));

  /** Opens the builder filled from a quote: "edit" corrects that draft, "copy" makes a new quote with a new number. */
  async function openFromQuote(quote: QuoteRow, mode: "edit" | "copy") {
    try {
      const items = await fetchQuoteItems(quote);
      setLineItems(items.length ? items.map((item) => ({
        description: item.description, qty: item.quantity, unit: item.unitPrice, source: item.source, vat: toVatChoice(item.vatPct, item.vatExempt, vat.defaultChoice),
        part: item.partNumber ?? "", drawing: item.drawingNumber ?? "", rev: item.drawingRevision ?? "",
      })) : [defaultLine(vat.defaultChoice)]);
      setBuilderCustomer(quote.customer);
      setBuilderVatOn(quote.vatEnabled);
      setBuilderPreset({ mode, quote });
      setBuilderKey((key) => key + 1);
      setViewingQuote(null);
      setBuilderOpen(true);
    } catch (err) {
      toast.error(userMessage(err, "Couldn't load the quote's lines."));
    }
  }

  function closeBuilder(open: boolean) {
    setBuilderOpen(open);
    if (!open) { setFromRfq(null); rfqSeeded.current = false; }
    if (!open && builderPreset) {
      setBuilderPreset(null);
      setBuilderCustomer("");
      setLineItems([defaultLine(vat.defaultChoice)]);
      setBuilderVatOn(null);
      setBuilderKey((key) => key + 1);
    }
  }

  /** Quotes keep only the customer's name, and Send reads the e-mail from the customer record: so the RFQ's e-mail fills a blank one (never replaces one), or starts the record. The quote is already saved; a failure here is only said. */
  async function carryRfqEmail(customerName: string, rfqEmail: string) {
    try {
      const plan = planRfqEmailCarry(await fetchCustomers(), customerName, rfqEmail);
      if (plan.action !== "none") await saveCustomer(plan.customer);
    } catch (err) {
      console.error(err);
      toast.warning(`The quote is saved, but the RFQ's e-mail couldn't be added to ${customerName}. Add it on the Customers page before sending.`);
    }
  }

  async function saveQuote(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    await run(async () => {
      try {
        if (!supabase) throw new Error("Supabase is not configured.");
        const rows = lineItems.filter(lineInUse);
        const input = parseOrThrow(quoteSaveSchema, {
          customer: String(form.get("customer") || ""),
          description: String(form.get("description") || ""),
          customerNotes: String(form.get("customer_notes") || ""),
          internalNotes: String(form.get("internal_notes") || ""),
          terms: String(form.get("terms") || ""),
          validUntil: String(form.get("valid_until") || ""),
          customerPo: String(form.get("customer_po") || ""),
          lines: rows.map((item) => ({ description: item.description, quantity: item.qty, unitPrice: item.unit })),
        });
        const customerPo = customerPoText(input.customerPo);
        const lineVats = rows.map((item) => fromVatChoice(item.vat));
        const totals = documentTotals(input.lines.map((line, position) => ({ quantity: line.quantity, unitPrice: line.unitPrice, ...lineVats[position] })), 0, { vatEnabled: builderVat, standardRate: vat.standardRate });
        if (builderPreset?.mode === "edit") {
          const target = builderPreset.quote;
          if (!target.id || !target.updatedAt) throw new ValidationError("This quote can't be corrected here. Reload and try again.");
          const { error } = await supabase.rpc("replace_draft_quote", {
            p_quote: target.id,
            p_expected_updated_at: target.updatedAt,
            p_header: {
              customer: input.customer,
              description: input.description,
              customer_notes: input.customerNotes || null,
              internal_notes: input.internalNotes || null,
              terms: input.terms || null,
              valid_until: input.validUntil || "",
              vat_enabled: builderVat,
              total_value: totals.total,
            },
            p_lines: input.lines.map((line, position) => ({
              description: line.description, quantity: line.quantity, unit_price: line.unitPrice,
              vat_pct: lineVats[position].vatPct, vat_exempt: lineVats[position].vatExempt, source: rows[position]?.source ?? "manual",
              ...linePartFields(rows[position]),
            })),
          });
          if (error) throw error;
          // The customer PO is not one of replace_draft_quote's fields: set_quote_customer_po (123) changes it, only when it changed.
          if (customerPo !== customerPoText(target.customerPo)) {
            const { error: poError } = await supabase.rpc("set_quote_customer_po", { p_quote: target.id, p_customer_po: customerPo });
            if (poError) {
              toast.error(`Draft ${target.ref} was corrected, but its customer PO wasn't saved: ${userMessage(poError, "try again")}`);
              closeBuilder(false);
              void loadQuotes();
              return;
            }
          }
          void auditEvent({ action: "UPDATE", entityTable: "quotes", entityId: target.ref, newData: { corrected_draft: true } });
          toast.success(`Draft ${target.ref} corrected`);
          closeBuilder(false);
          void loadQuotes();
          return;
        }
        const quoteRef = await allocateNumber("QUO");
        const { error } = await supabase.rpc("create_with_lines", {
          p_parent: "quotes",
          p_header: {
            quote_ref: quoteRef,
            customer: input.customer,
            description: input.description,
            customer_notes: input.customerNotes || null,
            internal_notes: input.internalNotes || null,
            total_value: totals.total,
            vat_enabled: builderVat,
            valid_until: input.validUntil || null,
            terms: input.terms || null,
            // Sent only when there is one, so a quote with none saves as before.
            ...(customerPo ? { customer_po: customerPo } : {}),
            status: "draft",
            ...(fromRfq ? { rfq_id: fromRfq.id } : {}),
          },
          p_child: "quote_line_items",
          p_fk: "quote_id",
          p_lines: input.lines.map((line, position) => ({
            position,
            description: line.description,
            quantity: line.quantity,
            unit_price: line.unitPrice,
            vat_pct: lineVats[position].vatPct,
            vat_exempt: lineVats[position].vatExempt,
            source: rows[position]?.source ?? "manual",
            ...linePartFields(rows[position]),
          })),
        });
        if (error) throw error;
        void auditEvent({ action: "CREATE", entityTable: "quotes", entityId: quoteRef });
        toast.success(`Quote ${quoteRef} saved`);
        if (fromRfq && input.customer.trim().toLowerCase() === fromRfq.customer.trim().toLowerCase()) await carryRfqEmail(fromRfq.customer, fromRfq.email);
        // Reset only after a successful save.
        formEl.reset();
        setBuilderCustomer("");
        setLineItems([defaultLine(vat.defaultChoice)]);
        setBuilderVatOn(null);
        setBuilderPreset(null);
        setBuilderKey((key) => key + 1);
        setBuilderOpen(false);
        void loadQuotes();
      } catch (err) {
        toast.error(userMessage(err, "Could not save the quote. Nothing was saved."));
      }
    });
  }

  // Customer-facing document: never include internal notes.
  async function buildQuotePdf(quote: QuoteRow, items: QuoteItem[], currentProfile: CompanyProfile) {
    if (!items.length) throw new ValidationError("This quote has no line items, so there is nothing to print.");
    const profile = issuedCompany(currentProfile, quote.issuerSnapshot);
    // The lines must add up to the stored face value, or the PDF would show a total the customer wasn't given.
    const problem = quoteTotalsProblem(quote, items, profile);
    if (problem) throw problem;
    const billTo = issuedBillTo(quote.customerSnapshot, quote.customer) ?? await resolveCustomerAddress(quote.customer);
    // The PDF code is loaded when a PDF is made, not with the page.
    const { QuotePDF } = await import("@/components/pdf/QuotePDF");
    return (
      <QuotePDF
        data={{
          storedTotals: quoteStoredTotals(quote),
          number: quote.ref,
          date: fmtDate(quote.date ?? nowIso()),
          terms: quote.terms || profile.defaultQuoteTerms,
          validUntil: quote.validUntil ? fmtDate(quote.validUntil) : "",
          scope: quote.description,
          customerPo: quote.customerPo || undefined,
          billTo,
          lineItems: quotePdfLines(items),
          vatEnabled: quote.vatEnabled,
          customerMessage: quote.customerNotes ? [...profile.defaultCustomerMessage, quote.customerNotes] : undefined,
          company: profile,
        }}
      />
    );
  }

  async function downloadQuotePdf(quote: QuoteRow) {
    await downloadPdf(async () => {
      const profile = await requireCompanyProfile();
      const items = quote === viewingQuote && viewItems.length ? viewItems : await fetchQuoteItems(quote);
      return buildQuotePdf(quote, items, profile);
    }, pdfName(quote), { entityTable: "quotes", entityId: quote.ref });
  }

  /**
   * A draft's issuer and customer snapshots date from its last save. Before it is first sent or decided (audit R4)
   * they are retaken on the server: replace_draft_quote re-saves the draft's own lines unchanged and snapshots the
   * company profile and customer record as they are now. Issued quotes are never touched: their snapshot is history.
   */
  async function freshDraft(quote: QuoteRow, header: { valid_until?: string } = {}): Promise<QuoteRow> {
    if (quote.rawStatus !== "draft" || !supabase || !quote.id) return quote;
    if (!quote.updatedAt) throw new ValidationError("Reload the quotes and try again.");
    // Every field replace_draft_quote takes back, part / drawing / revision included (068), so re-saving changes nothing.
    const { data: lines, error } = await supabase.from("quote_line_items").select(`description, quantity, unit_price, vat_pct, vat_exempt, source${await databaseHas068() ? ", part_number, drawing_number, drawing_revision" : ""}`).eq("quote_id", quote.id).order("position");
    if (error) throw error;
    const { error: saveError } = await supabase.rpc("replace_draft_quote", { p_quote: quote.id, p_expected_updated_at: quote.updatedAt, p_header: header, p_lines: lines ?? [] });
    if (saveError) throw saveError;
    const { data: row, error: readError } = await supabase.from("quotes").select("updated_at, issuer_snapshot, customer_snapshot").eq("id", quote.id).single();
    if (readError) throw readError;
    const fresh: QuoteRow = { ...quote, ...(header.valid_until ? { validUntil: header.valid_until } : {}), updatedAt: row.updated_at ? String(row.updated_at) : undefined, issuerSnapshot: row.issuer_snapshot ?? undefined, customerSnapshot: row.customer_snapshot ?? undefined };
    setQuotes((current) => current.map((item) => (item.id === quote.id ? fresh : item)));
    setViewingQuote((current) => (current && current.id === quote.id ? fresh : current));
    return fresh;
  }

  /** A send of a rejected quote refused: told to the person (unless the caller does) and kept in the audit log as a SEND marked refused. */
  function refusedSend(quote: QuoteRow, reason: string, tell = true) {
    if (tell) toast.error(reason);
    void auditEvent({ action: "SEND", entityTable: "quotes", entityId: quote.ref, newData: { status: "rejected" }, metadata: { outcome: "refused", reason } });
  }

  /**
   * Send (go-live polish 19e): asks first, "Send QUO-0005 to buyer@acme.example?", naming the address on file and, for a draft with
   * no valid-until date, the date it will get. Nothing is prepared until the person confirms.
   */
  async function askToSend(quote: QuoteRow, expiryConfirmed = false) {
    if (quote.rawStatus === "superseded") {
      toast.error(`${quote.ref} has been replaced by a newer version: send the latest version.`);
      return;
    }
    const rejected = quoteRejectedSendBlock(quote.ref, quote.rawStatus);
    if (rejected) {
      refusedSend(quote, rejected);
      return;
    }
    const blocked = quoteSendBlock(quote.ref, quote.value);
    if (blocked) {
      toast.error(blocked);
      return;
    }
    // A draft whose "valid until" date has already passed would show as Expired the moment it is sent.
    if (quote.rawStatus === "draft" && quote.validUntil && quote.validUntil < toDateInput(new Date())) {
      toast.error(`${quote.ref} is only valid until ${fmtDate(quote.validUntil)}, which has passed. Edit the quote and set a new date before sending.`);
      return;
    }
    const expired = expiryConfirmed ? null : expiredQuoteCheck(quote.rawStatus, quote.validUntil, toDateInput(new Date()), "send");
    if (expired) {
      setExpiredAsk({ quote, action: "send", check: expired });
      return;
    }
    let email: string | null = null;
    try {
      email = (await resolveCustomer(quote.customer))?.email ?? null;
    } catch {
      email = null; // the question still names the customer; the e-mail opens with the address to fill in
    }
    // Go-live polish 19c: a draft sent with no valid-until date gets one, from today, for the company's validity (its default quote
    // terms, "Valid for 30 days"), else 30 days.
    const validUntil = quote.rawStatus === "draft" && !quote.validUntil ? defaultValidUntil(toDateInput(new Date()), quoteValidityDays(company?.defaultQuoteTerms)) : null;
    setSendAsk({ quote, email, validUntil });
  }

  /** Mark Accepted: asks first when the quote is past its valid-until date, then opens the decision form as it always did. */
  function askToAccept(quote: QuoteRow, expiryConfirmed = false) {
    const blocked = quoteAcceptBlock(quote.value);
    if (blocked) {
      toast.error(blocked);
      return;
    }
    const expired = expiryConfirmed ? null : expiredQuoteCheck(quote.rawStatus, quote.validUntil, toDateInput(new Date()), "accept");
    if (expired) {
      setExpiredAsk({ quote, action: "accept", check: expired });
      return;
    }
    setDecisionUnticked(new Set());
    // The quote's own customer PO is the starting value (decision 16); change it here if the customer's order says otherwise.
    setDecisionPo(quote.customerPo);
    setDecision({ quote, outcome: "accepted" });
  }

  /**
   * Opens an email draft to the customer and downloads the PDF to attach ("Yes, send"; recording it as sent is a separate step), or,
   * with `oneClick` ("Email it now"), the send dialog: sent from here with the PDF attached, and recorded as sent once it has gone.
   */
  async function sendQuote(quote: QuoteRow, validUntil: string | null = null, oneClick = false) {
    await run(async () => {
      try {
        const profile = await requireCompanyProfile();
        const items = quote === viewingQuote && viewItems.length ? viewItems : await fetchQuoteItems(quote);
        // The PDF the customer gets is made from details as they are now (R4); the draft keeps that snapshot, and the default
        // valid-until date when it had none (saved on the draft before the PDF is made, so the PDF and the record agree).
        quote = await freshDraft(quote, validUntil && quote.rawStatus === "draft" && !quote.validUntil ? { valid_until: validUntil } : {});
        // The stored status, read again: the row may have been rejected elsewhere since this list was loaded.
        let storedStatus = quote.rawStatus;
        if (supabase && quote.id && quote.rawStatus !== "draft") {
          const { data: current, error: statusError } = await supabase.from("quotes").select("status").eq("id", quote.id).single();
          if (statusError) throw statusError;
          storedStatus = storedQuoteStatus(current?.status);
        }
        const rejected = quoteRejectedSendBlock(quote.ref, storedStatus);
        if (rejected) {
          refusedSend(quote, rejected, false);
          throw new ValidationError(rejected);
        }
        const blocked = quoteSendBlock(quote.ref, quote.value);
        if (blocked) throw new ValidationError(blocked);
        const element = await buildQuotePdf(quote, items, profile);
        const customer = await resolveCustomer(quote.customer);
        if (!customer?.email) toast.info(`No email address on file for ${quote.customer}. Add one on the Customers page, or type it into the email.`);
        const ready = quote;
        // The old way (also the "Open in my mail app" link): the person's own mail app, the PDF downloaded to attach, then "has it gone?".
        const mailApp = async (subject: string, body: string) => {
          openMailDraft(customer?.email ?? "", subject, body);
          const ok = await downloadPdf(element, pdfName(quote), { entityTable: "quotes", entityId: quote.ref }, { silent: true });
          if (!ok) return;
          toast.success("PDF downloaded \u2014 attach it to the email that just opened");
          setSendConfirm(ready);
        };
        const vars = { document_number: ready.ref, company_name: profile.name, customer_name: ready.customer, total: currency(ready.value) };
        if (!oneClick || !ready.id || DEMO_MODE) {
          const email = renderTemplate("quote", vars, await loadTemplateOverride(supabase, "quote"));
          await mailApp(email.subject, email.text);
          return;
        }
        // One-click send (E8): the dialog sends it with the PDF attached; once it has gone, the quote is recorded as sent.
        setEmailRequest({
          kind: "quote", recordId: ready.id, templateKey: "quote", to: customer?.email, vars,
          pdf: { filename: pdfName(ready), build: () => pdfBlob(element) },
          onOpenMailApp: (subject, body) => { setEmailRequest(null); void mailApp(subject, body); },
          onSent: () => void confirmQuoteSent(ready),
        });
      } catch (err) {
        toast.error(err instanceof ValidationError ? err.message : typeof err === "object" && err && "code" in err ? friendlyError(err, "Couldn't prepare the quote. Reload and try again.") : pdfErrorMessage(err));
      }
    });
  }

  /** Staff confirmed the e-mail went: a draft becomes sent (and is then fixed, migration 020). */
  async function confirmQuoteSent(quote: QuoteRow) {
    await run(async () => {
      try {
        const rejected = quoteRejectedSendBlock(quote.ref, quote.rawStatus);
        if (rejected) {
          refusedSend(quote, rejected, false);
          throw new ValidationError(rejected);
        }
        if (canRecordDecision(quote.rawStatus) && quote.rawStatus !== "sent") {
          if (supabase && quote.id) {
            // Only a quote still in the state shown moves; zero rows changed is not success (R7).
            const { data: moved, error } = await supabase.from("quotes").update({ status: "sent", sent_at: nowIso() }).eq("id", quote.id).eq("status", quote.rawStatus).select("id");
            if (error) throw error;
            if (moved?.length !== 1) throw new ValidationError(`${quote.ref} was changed elsewhere and wasn't recorded as sent. Reload and check it.`);
          } else if (!DEMO_MODE) {
            throw new Error("Supabase is not configured.");
          }
          const sent = (item: QuoteRow) => ({ ...item, rawStatus: "sent" as const, status: effectiveQuoteStatus("sent", item.validUntil, toDateInput(new Date())) });
          setQuotes((current) => current.map((item) => sameQuote(item, quote) ? sent(item) : item));
          setViewingQuote((current) => current && sameQuote(current, quote) ? sent(current) : current);
        } else if (quote.rawStatus === "sent" && supabase && quote.id) {
          // Sent again: the latest send is the one on record (sent_at / sent_by); the database logs RESEND and keeps the first send in the history (035).
          const { data: moved, error } = await supabase.from("quotes").update({ sent_at: nowIso() }).eq("id", quote.id).eq("status", "sent").select("id");
          if (error) throw error;
          if (moved?.length !== 1) throw new ValidationError(`${quote.ref} was changed elsewhere and the new send wasn't recorded. Reload and check it.`);
        }
        // Audit only once the status update has actually been saved.
        void auditEvent({ action: "SEND", entityTable: "quotes", entityId: quote.ref, newData: { status: canRecordDecision(quote.rawStatus) ? "sent" : quote.rawStatus } });
        setSendConfirm(null);
        toast.success(quote.rawStatus === "draft" ? `${quote.ref} recorded as sent: moved from Drafts to Sent` : `${quote.ref} recorded as sent`);
      } catch (err) {
        toast.error(err instanceof ValidationError ? err.message : friendlyError(err, "Couldn't record the quote as sent."));
      }
    });
  }

  /** The customer's PO can be added or changed on a draft, sent or accepted quote (migration 123); a rejected or replaced one is final. */
  function canSetCustomerPo(quote: QuoteRow) {
    return Boolean(quote.id && supabase && !DEMO_MODE) && ["draft", "sent", "accepted"].includes(quote.rawStatus);
  }

  /**
   * Saves the customer's PO on the quote (set_quote_customer_po, migration 123). On an accepted quote it also reaches the quote's order,
   * its unfinished job and its draft invoices, in the same call; an issued invoice keeps the PO it was issued with.
   */
  async function saveQuoteCustomerPo() {
    const quote = poQuote;
    if (!quote?.id) return;
    await run(async () => {
      try {
        if (!supabase) throw new Error("Supabase is not configured.");
        const po = customerPoInput(poDraft);
        if (!po && quote.rawStatus !== "draft") throw new ValidationError("Enter the customer's order number");
        const { data, error } = await supabase.rpc("set_quote_customer_po", { p_quote: quote.id, p_customer_po: po });
        if (error) throw error;
        const result = data as { customer_po: string | null; changed: boolean; job_no?: string | null; job_updated?: boolean; draft_invoices?: number };
        const saved = result.customer_po ?? "";
        setQuotes((rows) => rows.map((item) => sameQuote(item, quote) ? { ...item, customerPo: saved } : item));
        setViewingQuote((viewing) => viewing && sameQuote(viewing, quote) ? { ...viewing, customerPo: saved } : viewing);
        setPoQuote(null);
        setPoDraft("");
        if (!result.changed) return void toast.info(`${quote.ref} already has that customer PO`);
        const reached = [result.job_updated && result.job_no ? `job ${result.job_no}` : "", result.draft_invoices ? `${result.draft_invoices} draft invoice${result.draft_invoices === 1 ? "" : "s"}` : ""].filter(Boolean);
        toast.success(saved ? `${CUSTOMER_PO_LABEL} ${saved} saved on ${quote.ref}${reached.length ? ` and on ${reached.join(" and ")}` : ""}` : `${CUSTOMER_PO_LABEL} removed from ${quote.ref}`);
      } catch (err) {
        toast.error(userMessage(err, "Could not save the customer PO"));
      }
    });
  }

  /** Records the customer's decision (accepted / rejected). Final once saved: the database refuses later changes. */
  async function recordDecision(quote: QuoteRow, outcome: "accepted" | "rejected") {
    await run(async () => {
      try {
        if (!supabase || !quote.id) throw new ValidationError("This quote must be saved before a decision can be recorded.");
        if (!canRecordDecision(quote.rawStatus)) throw new ValidationError(`${quote.ref} is already ${quote.rawStatus}.`);
        // A decision on a draft is its first issue: snapshot the details as they are now (R4).
        const current = await freshDraft(quote);
        const decided = (item: QuoteRow) => ({ ...item, rawStatus: outcome, status: outcome });
        if (outcome === "accepted") {
          // The lines the customer's PO covers (068): null = all of them (sent only when some are unticked, so the call is 058's otherwise).
          const items = quote === viewingQuote || (viewingQuote && sameQuote(quote, viewingQuote)) ? viewItems : await fetchQuoteItems(quote);
          const ids = items.map((item) => item.id).filter((id): id is string => Boolean(id));
          let lines: string[] | null = null;
          try {
            lines = ids.length ? acceptedLineIds(ids, new Set(ids.filter((id) => !decisionUnticked.has(id)))) : null;
          } catch (err) {
            throw new ValidationError(err instanceof Error ? err.message : "Tick at least one line the customer ordered.");
          }
          // One database call (accept_quote, migration 058): the quote accepted, its sales order made and, when the company's setting is
          // automatic, its job (not started). Audited there (ACCEPT, once). A quote one order can't hold is still accepted: the toast
          // says why and points to Sales Orders, where the order is entered by hand.
          // A PO typed here that the quote doesn't hold yet goes on the quote first (123), so the quote shows it beside its number.
          const typedPo = customerPoInput(decisionPo);
          if (typedPo && typedPo !== customerPoText(quote.customerPo)) {
            const { error: poError } = await supabase.rpc("set_quote_customer_po", { p_quote: current.id!, p_customer_po: typedPo });
            if (poError) throw poError;
            setQuotes((rows) => rows.map((item) => sameQuote(item, quote) ? { ...item, customerPo: typedPo } : item));
            setViewingQuote((viewing) => viewing && sameQuote(viewing, quote) ? { ...viewing, customerPo: typedPo } : viewing);
          }
          const { data, error } = await supabase.rpc("accept_quote", { p_quote: current.id!, p_customer_po: typedPo, p_delivery_date: deliveryDateInput(decisionDue), ...(lines ? { p_lines: lines } : {}) });
          if (error) throw error;
          const result = data as AcceptQuoteResult;
          // Accepted for part of its lines: the figures count only the ordered ones (as loadQuotes does on the next load).
          const declinedValue = lines && result.accepted
            ? declinedValueByQuote(items.filter((item) => item.id && !lines!.includes(item.id)).map((item) => ({ quote_id: quote.id, quantity: item.quantity, unit_price: item.unitPrice, vat_pct: item.vatPct, vat_exempt: item.vatExempt })), () => quote.vatEnabled).get(quote.id!)
            : undefined;
          setQuotes((rows) => rows.map((item) => sameQuote(item, quote) ? { ...decided(item), ...(declinedValue !== undefined ? { declinedValue } : {}) } : item));
          setViewingQuote((viewing) => viewing && sameQuote(viewing, quote) ? decided(viewing) : viewing);
          if (lines) setViewItems((items) => items.map((item) => ({ ...item, declined: !lines!.includes(item.id ?? "") })));
          setDecision(null);
          setDecisionPo("");
          setDecisionDue("");
          const told = acceptOutcome(result, quote.ref);
          // With a job to open, the quote's dialog closes: its overlay would otherwise block the toast's "Open job" button.
          if (told.link) setViewingQuote(null);
          const options = told.link ? { duration: 12_000, action: { label: told.link.label, onClick: () => router.push(told.link!.href) } } : undefined;
          if (told.tone === "warning") toast.warning(told.message, options);
          else if (told.tone === "info") toast.info(told.message, options);
          else toast.success(told.message, options);
          return;
        }
        const { data: moved, error } = await supabase.from("quotes").update({ status: "rejected", rejected_at: nowIso() }).eq("id", current.id!).eq("status", current.rawStatus).select("id");
        if (error) throw error;
        if (moved?.length !== 1) throw new ValidationError(`${quote.ref} was changed elsewhere, so the decision wasn't saved. Reload and check it.`);
        setQuotes((rows) => rows.map((item) => sameQuote(item, quote) ? decided(item) : item));
        setViewingQuote((viewing) => viewing && sameQuote(viewing, quote) ? decided(viewing) : viewing);
        setDecision(null);
        void auditEvent({ action: "REJECT", entityTable: "quotes", entityId: quote.ref, newData: { status: outcome } });
        toast.success(`${quote.ref} marked as rejected`);
      } catch (err) {
        toast.error(userMessage(err, "Could not record the decision"));
      }
    });
  }

  /**
   * Revise a sent quote as a new version (revise_quote, migration 068): the next version is made as a draft from this one (same number,
   * " v2" ...), and this one is kept, read only, as superseded. The new draft opens for editing; send it as usual.
   */
  async function reviseQuote(quote: QuoteRow) {
    await run(async () => {
      try {
        if (!supabase || !quote.id) throw new ValidationError("This quote must be saved before it can be revised.");
        const { data, error } = await supabase.rpc("revise_quote", { p_quote: quote.id });
        if (error) throw error;
        const made = data as { quote_id: string; quote_ref: string; version: number };
        setReviseAsk(null);
        toast.success(`${made.quote_ref} made as a draft. ${quote.ref} is kept, read only, as the previous version.`);
        const rows = await loadQuotes();
        const draft = rows.find((row) => row.id === made.quote_id);
        if (draft) await openFromQuote(draft, "edit");
      } catch (err) {
        toast.error(userMessage(err, "Couldn't revise the quote. Nothing was changed."));
      }
    });
  }

  const viewVat = Boolean(viewingQuote?.vatEnabled) && vat.registered;
  // Every version of the quote being viewed, oldest first (068), and the newer one that replaced it.
  const viewVersions = useMemo(() => (viewingQuote ? versionChain(quotes, viewingQuote) : []), [quotes, viewingQuote]);
  const viewReplacedBy = viewingQuote?.id ? quotes.find((row) => row.previousVersionId === viewingQuote.id) : undefined;
  // Lines that don't add up to the stored face value (imported records): show the stored total and why it can't print.
  const viewProblem = viewingQuote && viewItems.length && company ? quoteTotalsProblem(viewingQuote, viewItems, issuedCompany(company, viewingQuote.issuerSnapshot)) : null;
  const viewTotals = viewItems.length ? documentTotals(viewItems.map((item) => ({ quantity: item.quantity, unitPrice: item.unitPrice, ...lineVat(item) })), 0, { vatEnabled: viewVat, standardRate: vat.standardRate }) : null;

  return (
    <RoleGate allowed={["admin", "office"]}>
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div><h1 className="page-title">Quote Generator</h1><p className="mt-2 text-sm text-slate-500">A quote is the price we offer a customer. Make, send and follow up quotes here.</p></div>
        <div className="flex flex-wrap items-center gap-2"><ColumnToggle tableKey="quotes" /><ViewSwitcher value={view} onChange={setView} />
        <Dialog open={builderOpen} onOpenChange={closeBuilder}>
          <DialogTrigger asChild><Button className="bg-brand text-brand-ink hover:bg-brand-hover"><Plus className="size-4" /> New quote</Button></DialogTrigger>
          <DialogContent className="max-w-4xl">
            <DialogHeader><DialogTitle>{builderPreset?.mode === "edit" ? `Correct draft ${builderPreset.quote.ref}` : builderPreset?.mode === "copy" ? `Copy of ${builderPreset.quote.ref}` : fromRfq ? `Quote Builder: RFQ from ${fromRfq.customer}` : "Quote Builder"}</DialogTitle><DialogDescription>{builderPreset?.mode === "edit" ? "Change the draft and save. It keeps its number." : builderPreset?.mode === "copy" ? "A new quote with a new number, starting from this one." : "Build a detailed quote with line items and VAT."}</DialogDescription></DialogHeader>
            <form key={builderKey} onSubmit={saveQuote} className="space-y-4">
              <div className="grid gap-3 md:grid-cols-3">
                <CustomerSelect name="customer" required value={builderCustomer} onValueChange={setBuilderCustomer} />
                <label className="grid gap-1 text-xs text-slate-500">Valid until<Input name="valid_until" type="date" defaultValue={builderPreset?.mode === "edit" ? builderPreset.quote.validUntil : ""} /></label>
                <label className="grid gap-1 text-xs text-slate-500">Terms<Input name="terms" maxLength={200} placeholder={company?.defaultQuoteTerms ?? "Valid for 30 days"} defaultValue={builderPreset?.quote.terms ?? ""} /></label>
                <label className="grid gap-1 text-xs text-slate-500">{CUSTOMER_PO_LABEL} (optional)<Input name="customer_po" maxLength={100} placeholder="Customer order number (their PO)" defaultValue={builderPreset?.mode === "edit" ? builderPreset.quote.customerPo : ""} /></label>
              </div>
              <Textarea name="description" placeholder="Quote description" maxLength={2000} defaultValue={builderPreset?.quote.description ?? fromRfq?.description ?? ""} />
              <div className="space-y-2">
                <div className="hidden gap-2 text-xs font-medium text-slate-500 md:grid md:grid-cols-[minmax(0,1fr)_90px_120px_100px_120px_40px]"><span>Description</span><span>Qty</span><span>Unit price</span><span>VAT</span><span>Line total</span><span /></div>
                {lineItems.map((item, index) => (
                  <div key={index} className="grid grid-cols-2 gap-2 md:grid-cols-[minmax(0,1fr)_90px_120px_100px_120px_40px]">
                    <div className="col-span-2 grid gap-1 md:col-span-1"><span aria-hidden className="field-label md:hidden">Description</span><Input value={item.description} maxLength={500} aria-label="Description" onChange={(e) => setLineItems((rows) => rows.map((row, i) => i === index ? { ...row, description: e.target.value } : row))} /></div>
                    <div className="grid gap-1"><span aria-hidden className="field-label md:hidden">Qty</span><Input type="number" step="0.001" min="0" inputMode="decimal" aria-label="Quantity" value={item.qty} onChange={(e) => setLineItems((rows) => rows.map((row, i) => i === index ? { ...row, qty: Number(e.target.value) } : row))} /></div>
                    <div className="grid gap-1"><span aria-hidden className="field-label md:hidden">Unit price</span><Input type="number" step="0.01" min="0" inputMode="decimal" aria-label="Unit price" value={item.unit} onChange={(e) => setLineItems((rows) => rows.map((row, i) => i === index ? { ...row, unit: Number(e.target.value) } : row))} /></div>
                    <div className="grid gap-1"><span aria-hidden className="field-label md:hidden">VAT</span><VatRateSelect value={item.vat} disabled={!builderVat} onChange={(choice) => setLineItems((rows) => rows.map((row, i) => i === index ? { ...row, vat: choice } : row))} /></div>
                    <div className="grid gap-1"><span aria-hidden className="field-label md:hidden">Line total</span><div className="rounded-lg bg-slate-50 px-3 py-2 text-sm">{currency(documentTotals([{ quantity: item.qty, unitPrice: item.unit, vatPct: 0 }]).subtotal)}</div></div>
                    <Button type="button" variant="ghost" size="icon" className="col-span-2 w-full md:col-span-1 md:w-auto" aria-label="Remove line" onClick={() => setLineItems((rows) => rows.filter((_, i) => i !== index))}><Trash2 className="size-4" /></Button>
                    {/* One row per part (068): optional part number, drawing number and its revision, printed under the line on the quote. */}
                    {has068 ? <div className="col-span-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_5rem] gap-2 md:col-span-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px_40px]">
                      <Input value={item.part} maxLength={100} placeholder="Part no." aria-label="Part number" onChange={(e) => setLineItems((rows) => rows.map((row, i) => i === index ? { ...row, part: e.target.value } : row))} />
                      <Input value={item.drawing} maxLength={100} placeholder="Drawing no." aria-label="Drawing number" onChange={(e) => setLineItems((rows) => rows.map((row, i) => i === index ? { ...row, drawing: e.target.value } : row))} />
                      <Input value={item.rev} maxLength={20} placeholder="Rev" aria-label="Drawing revision" onChange={(e) => setLineItems((rows) => rows.map((row, i) => i === index ? { ...row, rev: e.target.value } : row))} />
                    </div> : null}
                  </div>
                ))}
              </div>
              <Button type="button" variant="outline" onClick={() => setLineItems((rows) => [...rows, { ...defaultLine(vat.defaultChoice), description: "New line item" }])}>Add Row</Button>
              <CostingLinePicker onAdd={(line) => { const costed: BuilderLine = { ...defaultLine(vat.defaultChoice), ...line, source: "costing_engine" }; setLineItems((rows) => rows.length === 1 && rows[0].unit === 0 ? [costed] : [...rows, costed]); }} />
              <div className="flex flex-wrap items-start justify-between gap-4">
                <VatToggle registered={vat.registered} checked={builderVat} onChange={setBuilderVatOn} />
                <VatTotals totals={builderTotals} vatEnabled={builderVat} className="w-full max-w-xs space-y-1 rounded-lg bg-slate-50 p-4 text-sm" />
              </div>
              <div className="space-y-1"><label className="text-sm font-medium text-slate-700" htmlFor="customer_notes">Notes for customer</label><Textarea id="customer_notes" name="customer_notes" maxLength={2000} placeholder="Shown on the quote sent to the customer" defaultValue={builderPreset?.quote.customerNotes ?? ""} /></div>
              <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3">
                <label className="flex items-center gap-1.5 text-sm font-medium text-amber-900" htmlFor="internal_notes"><Lock className="size-3.5" /> Internal notes (not shown to customer)</label>
                <Textarea id="internal_notes" name="internal_notes" maxLength={2000} placeholder="Margins, supplier quotes, risks - for the team only" className="bg-white" defaultValue={builderPreset?.quote.internalNotes ?? ""} />
              </div>
              <Button type="submit" disabled={saving} className="bg-brand text-brand-ink hover:bg-brand-hover">{saving ? "Saving…" : builderPreset?.mode === "edit" ? "Save Correction" : "Save Quote"}</Button>
            </form>
          </DialogContent>
        </Dialog>
        </div>
      </div>

      {DEMO_MODE ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Demo mode: sample data is shown if the database can&apos;t be reached.</div> : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {([
          ["Open Quotes", String(stats.open.count), `${currency(stats.open.value)} awaiting reply`, "sent"],
          ["Drafts", String(stats.drafts.count), `${currency(stats.drafts.value)} not yet sent`, "draft"],
          ["Accepted Quotes", String(stats.byStatus.accepted.count), `${currency(stats.byStatus.accepted.value)} won`, "accepted"],
          ["Win Rate", stats.winRate === null ? "-" : `${stats.winRate}%`, "Accepted of sent quotes decided or expired", "accepted"],
        ] as const).map(([label, value, sub, status]) => (
          <StatTile key={label} label={label} value={loading ? "—" : value} sub={sub} tone={status === "accepted" ? "good" : status === "sent" ? "info" : "neutral"}
            active={filters.size === 1 && filters.has(status)} onClick={() => setFilters(new Set([status]))} />
        ))}
      </div>
      {scopeTotal ? (
        <div className="space-y-2">
          <div className="flex h-1.5 w-full overflow-hidden rounded-none bg-ink/5" role="img" aria-label="Quotes by status">
            {STATUS_ORDER.filter((status) => scopeCounts[status]).map((status) => (
              <span key={status} title={`${STATUS_STYLES[status].label}: ${scopeCounts[status]}`} className={`${STATUS_STYLES[status].bar} h-full`} style={{ width: `${(scopeCounts[status] / scopeTotal) * 100}%` }} />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
            <span className="font-semibold">{legend.scope}{!listFilter && phase === "open" ? " (expired quotes are under Done)" : ""}:</span>
            {STATUS_ORDER.map((status) => <span key={status} className="inline-flex items-center gap-1.5"><span className={`size-2.5 rounded-none ${STATUS_STYLES[status].bar}`} />{STATUS_STYLES[status].label} ({scopeCounts[status]})</span>)}
          </div>
        </div>
      ) : null}
      {listFilter ? <ListFilterNotice label={QUOTE_FILTER_LABELS[listFilter] ?? listFilter} onClear={clearListFilter} /> : null}
      <PhaseFilter value={phase} onChange={setPhase} counts={phaseCounts} />
      <FilterBar activeValues={[...filters]} options={[{ label: "All", value: "all" }, { label: "Draft", value: "draft" }, { label: "Sent", value: "sent" }, { label: "Accepted", value: "accepted" }, { label: "Rejected", value: "rejected" }, { label: "Expired", value: "expired" }, { label: "Superseded", value: "superseded" }]} onChange={setFilters} />
      <ListToolbar
        visibleCount={visible.length}
        selectedCount={selectedRefs.length}
        onSelectAll={() => setSelectedRefs(visible.map((quote) => quote.ref))}
        onClear={() => setSelectedRefs([])}
        exports={[
          { label: "CSV", title: scopeTitle, onSelect: () => void exportSpreadsheet("csv", "Quotes", QUOTE_COLUMNS, exportScope, "quotes") },
          { label: "Excel", title: scopeTitle, onSelect: () => void exportSpreadsheet("xlsx", "Quotes", QUOTE_COLUMNS, exportScope, "quotes") },
          { label: "Word", title: scopeTitle, onSelect: () => void exportRows("word", EXPORT_TITLES.quotes, selectedRows, "quotes") },
          { label: "PDF", title: scopeTitle, onSelect: () => void exportRows("pdf", EXPORT_TITLES.quotes, selectedRows, "quotes") },
        ]}
      />
      {loadError ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <span>{loadError}</span>
          <Button variant="outline" size="sm" onClick={() => void loadQuotes()}>Retry</Button>
        </div>
      ) : null}
      {loading ? <div className="grid gap-4 md:grid-cols-2"><Skeleton className="h-40" /><Skeleton className="h-40" /></div> : !loadError || DEMO_MODE ? (
        visible.length === 0 ? (
          <EmptyList
            title={quotes.length ? "No quotes match this filter" : "No quotes yet"}
            hint={quotes.length ? "Try a different filter." : quotesEmptyHint()}
            hintTestId={quotes.length ? undefined : "empty-hint"}
            action={quotes.length ? <Button variant="outline" onClick={() => setFilters(new Set(["all"]))}>Show all</Button> : <Button className="bg-brand text-brand-ink hover:bg-brand-hover" onClick={() => setBuilderOpen(true)}><Plus className="size-4" /> New quote</Button>}
          />
        ) : (
        <>
        {view !== "cards" ? (
          <Card className="hidden md:block">
            <CardContent className="p-0">
              <Table className="table-fixed" data-tablet-cards aria-label="Quotes">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-9"><SelectBox aria-label={`Select all ${visible.length} filtered quotes`} checked={visible.length > 0 && visible.every((quote) => selectedRefs.includes(quote.ref))} onChange={(event) => setSelectedRefs(event.target.checked ? visible.map((quote) => quote.ref) : [])} /></TableHead>
                    {isVisible("ref") ? <TableHead className="w-32 max-desk:w-28">Quote</TableHead> : null}
                    {isVisible("date") ? <TableHead className="w-28 max-desk:w-24">Date</TableHead> : null}
                    {isVisible("customer") ? <TableHead>Customer</TableHead> : null}
                    {isVisible("description") ? <TableHead>Description</TableHead> : null}
                    {isVisible("status") ? <TableHead className="w-32">Status</TableHead> : null}
                    {isVisible("value") ? <TableHead className="w-32 text-right max-desk:w-[5.5rem]">Value</TableHead> : null}
                    {isVisible("valid") ? <TableHead className="w-28">Valid until</TableHead> : null}
                    {/* Below desktop width (Valid until hidden) Quote, Date and Value narrow so Customer and Description keep room for their headings at 820 (cell padding px-2 there too). */}
                    {/* w-32: the three size-8 icon buttons and their gaps exactly (px-3 each side); a wider column starves Customer and Description at 1280. */}
                    <TableHead className="w-32 text-right max-desk:w-[7.5rem]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((quote) => (
                    <TableRow key={quote.id ?? quote.ref} className={selectedRefs.includes(quote.ref) ? "bg-brand-accent/5" : undefined}>
                      <TableCell><SelectBox aria-label={`Select ${quote.ref}`} checked={selectedRefs.includes(quote.ref)} onChange={() => setSelectedRefs((current) => current.includes(quote.ref) ? current.filter((ref) => ref !== quote.ref) : [...current, quote.ref])} /></TableCell>
                      {isVisible("ref") ? <TableCell data-label="Quote" className="font-mono font-bold whitespace-normal [overflow-wrap:anywhere]">{quote.ref}{quote.customerPo ? <span data-testid="quote-customer-po" className="block font-sans text-xs font-normal text-slate-500">{customerPoBeside(quote.customerPo)}</span> : null}</TableCell> : null}
                      {isVisible("date") ? <TableCell data-label="Date">{quote.date ? fmtDate(quote.date) : ""}</TableCell> : null}
                      {isVisible("customer") ? <TableCell data-label="Customer"><span className="block truncate" title={quote.customer}>{quote.customer}</span></TableCell> : null}
                      {isVisible("description") ? <TableCell data-label="Description" className="whitespace-normal"><span className="block break-words text-slate-600 dark:text-slate-300">{quote.description}</span></TableCell> : null}
                      {isVisible("status") ? <TableCell data-label="Status"><StatusBadge status={quoteStatusKey(quote.status)} label={quote.status} className="capitalize" unmapped={{ className: statusStyle(quote.status).badge }} /></TableCell> : null}
                      {isVisible("value") ? <TableCell data-label="Value" className="font-semibold tabular-nums desk:text-right">{currency(quote.value)}</TableCell> : null}
                      {isVisible("valid") ? <TableCell data-label="Valid until">{quote.validUntil ? fmtDate(quote.validUntil) : "\u2014"}</TableCell> : null}
                      <TableCell data-actions>
                        <div className="flex flex-wrap gap-1 desk:justify-end">
                          <Button size="icon" variant="outline" className="size-8" title={`View ${quote.ref}`} aria-label={`View ${quote.ref}`} onClick={() => setViewingQuote(quote)}><Eye className="size-4" aria-hidden /></Button>
                          {canOfferSend(quote.rawStatus) ? <Button size="icon" className="size-8 bg-brand text-brand-ink hover:bg-brand-hover" title={`${quote.rawStatus === "draft" ? "Send" : "Resend"} ${quote.ref} to the customer`} aria-label={`${quote.rawStatus === "draft" ? "Send" : "Resend"} ${quote.ref} to the customer`} disabled={saving} onClick={() => void askToSend(quote)}><Send className="size-4" /></Button> : null}
                          <Button size="icon" variant="outline" className="size-8" title={`Download ${quote.ref} as PDF`} aria-label={`Download ${quote.ref} as PDF`} onClick={() => void downloadQuotePdf(quote)}><Download className="size-4" aria-hidden /></Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ) : null}
        <div className={`space-y-6 ${view !== "cards" ? "md:hidden" : ""}`}>
        {groups.map((group) => (
        <section key={group.status} aria-label={`${STATUS_STYLES[group.status].label} quotes`}>
        <h2 className={`mb-2 flex items-center gap-2 text-sm font-semibold ${STATUS_STYLES[group.status].text}`}><span className={`size-2.5 rounded-none ${STATUS_STYLES[group.status].bar}`} />{group.status === "draft" ? "Drafts" : STATUS_STYLES[group.status].label} ({group.items.length})</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {group.items.map((quote) => (
            <Card key={quote.id ?? quote.ref} className={selectedRefs.includes(quote.ref) ? "border-brand-accent/60 ring-1 ring-brand-accent/40" : undefined}>
              {isVisible("ref") ? <CardHeader><CardTitle className="font-bold break-words">{quote.ref}</CardTitle></CardHeader> : null}
              <CardContent className="space-y-4">
                <label className="flex items-center gap-2 text-sm text-slate-600 pointer-coarse:min-h-11"><input type="checkbox" className="pointer-coarse:size-6" checked={selectedRefs.includes(quote.ref)} onChange={() => setSelectedRefs((current) => current.includes(quote.ref) ? current.filter((ref) => ref !== quote.ref) : [...current, quote.ref])} /> Select for export</label>
                {/* Labelled fields in the Quotes column order (Quote above; Actions below): Date, Customer, Description, Status, Value, Valid until. */}
                <dl className="min-w-0 space-y-2 break-words text-sm">
                  {isVisible("date") ? <div><dt className="label-mono field-caption">Date</dt><dd>{quote.date ? fmtDate(quote.date) : "\u2014"}</dd></div> : null}
                  {isVisible("customer") ? <div><dt className="label-mono field-caption">Customer</dt><dd className="font-semibold text-slate-950">{quote.customer}</dd></div> : null}
                  {isVisible("description") ? <div><dt className="label-mono field-caption">Description</dt><dd data-testid="quote-card-description" className="text-slate-600 dark:text-slate-300">{quote.description || "\u2014"}</dd></div> : null}
                  {isVisible("status") ? <div><dt className="label-mono field-caption">Status</dt><dd><StatusBadge status={quoteStatusKey(quote.status)} label={quote.status} className="capitalize" unmapped={{ className: statusStyle(quote.status).badge }} /></dd></div> : null}
                  {isVisible("value") ? <div><dt className="label-mono field-caption">Value</dt><dd className="text-2xl font-bold text-brand">{currency(quote.value)}</dd></div> : null}
                  {isVisible("valid") ? <div><dt className="label-mono field-caption">Valid until</dt><dd>{quote.validUntil ? fmtDate(quote.validUntil) : "No expiry date"}</dd></div> : null}
                </dl>
                {quote.rawStatus === "draft" && quote.validUntil && quote.validUntil < toDateInput(new Date()) ? <p className="text-sm font-medium text-red-700">Date has passed: edit before sending</p> : null}
                <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setViewingQuote(quote)}>View</Button>{!canOfferSend(quote.rawStatus) ? null : <Button className="bg-brand text-brand-ink hover:bg-brand-hover" disabled={saving} onClick={() => void askToSend(quote)}><Send className="size-4" /> {quote.rawStatus === "draft" ? "Send" : "Resend"}</Button>}<Button variant="outline" onClick={() => void downloadQuotePdf(quote)}><Download className="size-4" /> PDF</Button>{archive.canManage ? <ArchiveButton id={quote.id} phase={phaseFor(quote)} manual={quote.id ? archive.manual.get(quote.id) : undefined} onSet={archive.setState} size="default" /> : null}</div>
              </CardContent>
            </Card>
          ))}
        </div>
        </section>
        ))}
        </div>
        </>
        )
      ) : null}
      <Dialog open={Boolean(viewingQuote)} onOpenChange={(nextOpen) => !nextOpen && setViewingQuote(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle><span className="font-bold">{viewingQuote?.ref}</span> quote details</DialogTitle>
            <DialogDescription>Customer quote summary and line item breakdown.</DialogDescription>
          </DialogHeader>
          {viewingQuote ? (
            <div className="space-y-5">
              <AiDraftFlags notes={viewingQuote.internalNotes} />
              <div className="grid gap-4 rounded-lg border bg-slate-50 p-4 text-sm sm:grid-cols-2">
                <div className="min-w-0"><span className="field-label block">Customer</span><p className="font-semibold text-slate-950">{viewingQuote.customer}</p></div>
                <div className="min-w-0"><span className="field-label block">Status</span><p><StatusBadge status={quoteStatusKey(viewingQuote.status)} label={viewingQuote.status} className="capitalize" unmapped={{ className: statusStyle(viewingQuote.status).badge }} /></p></div>
                <div className="min-w-0"><span className="field-label block">Quote Ref</span><p className="font-mono font-bold text-slate-950">{viewingQuote.ref}</p></div>
                <div className="min-w-0" data-testid="quote-detail-customer-po"><span className="field-label block">{CUSTOMER_PO_LABEL}</span><p className="flex flex-wrap items-center gap-2 font-medium text-slate-950"><span className="font-mono">{viewingQuote.customerPo || "Not received yet"}</span>{canSetCustomerPo(viewingQuote) ? <Button variant="outline" size="sm" disabled={saving} onClick={() => { setPoDraft(viewingQuote.customerPo); setPoQuote(viewingQuote); }}>{viewingQuote.customerPo ? "Change customer PO" : "Add customer PO"}</Button> : null}</p></div>
                <div className="min-w-0"><span className="field-label block">Valid Until</span><p className="font-medium text-slate-950">{fmtDate(viewingQuote.validUntil) || "-"}</p></div>
                {viewingQuote.description.trim() ? <div className="min-w-0 sm:col-span-2" data-testid="quote-description"><span className="field-label block">Description</span><p className="whitespace-pre-line break-words text-slate-950">{viewingQuote.description}</p></div> : null}
              </div>
              {viewingQuote.rawStatus === "superseded" ? (
                <div role="status" data-testid="quote-superseded" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-300 bg-slate-50 p-3 text-sm text-slate-700">
                  <span>Replaced by {viewReplacedBy?.ref ?? "a newer version"}. This version is kept as it was sent, read only.</span>
                  {viewReplacedBy ? <Button variant="outline" size="sm" onClick={() => setViewingQuote(viewReplacedBy)}>View {viewReplacedBy.ref}</Button> : null}
                </div>
              ) : null}
              {viewVersions.length > 1 ? (
                <div data-testid="quote-versions" className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="field-label">Versions</span>
                  {viewVersions.map((version) => (
                    <Button key={version.id ?? version.ref} size="sm" variant={version.id === viewingQuote.id ? "default" : "outline"} disabled={version.id === viewingQuote.id} onClick={() => setViewingQuote(version)}>
                      v{version.version} <span className="font-normal capitalize">({version.status})</span>
                    </Button>
                  ))}
                </div>
              ) : null}
              {viewItemsError ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{viewItemsError}</div> : null}
              {/* Line items: four columns from sm up; stacked below that, each figure with its own caption (no header row to read it from). */}
              <div className="rounded-lg border" data-testid="quote-lines">
                <div className="hidden grid-cols-[minmax(0,1fr)_4.5rem_7rem_7rem] gap-3 border-b bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-600 sm:grid">
                  <span>Description</span><span>Qty</span><span>Unit Price</span><span>Total</span>
                </div>
                {viewItemsLoading ? <div className="p-4"><Skeleton className="h-8" /></div> : viewItems.length ? viewItems.map((item, index) => (
                  <div key={item.id ?? index} data-testid="quote-line" className={`grid grid-cols-3 gap-x-3 gap-y-1 border-b px-4 py-3 text-sm last:border-b-0 sm:grid-cols-[minmax(0,1fr)_4.5rem_7rem_7rem] sm:border-b-0 ${item.declined ? "text-slate-400" : ""}`}>
                    <span className="col-span-3 min-w-0 sm:col-span-1">
                      <span className={`whitespace-pre-line ${item.declined ? "line-through" : ""}`}>{item.description}</span>
                      {lineReference(item) ? <span className="block text-xs text-slate-500">{lineReference(item)}</span> : null}
                      {item.declined ? <Badge className="mt-1 bg-slate-100 text-slate-600" data-testid="quote-line-declined">Not ordered</Badge> : null}
                    </span>
                    <span className="min-w-0"><span className="field-label block sm:hidden">Qty</span>{item.quantity}</span>
                    <span className="min-w-0"><span className="field-label block sm:hidden">Unit Price</span>{currency(item.unitPrice)}</span>
                    <span className="min-w-0"><span className="field-label block sm:hidden">Total</span>{currency(documentTotals([{ quantity: item.quantity, unitPrice: item.unitPrice, vatPct: 0 }]).subtotal)}</span>
                  </div>
                )) : (
                  <p className="px-4 py-3 text-sm text-slate-500">No line items recorded for this quote.</p>
                )}
              </div>
              <div className="ml-auto w-full max-w-xs space-y-1 rounded-lg bg-slate-50 p-4 text-sm">
                {viewTotals && !viewProblem ? (
                  <>
                    <VatTotals totals={viewTotals} vatEnabled={viewVat} className="space-y-1" />
                  </>
                ) : (
                  <div className="flex justify-between font-bold"><span>Quoted total</span><span>{currency(viewingQuote.value)}</span></div>
                )}
              </div>
              {viewProblem ? <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">{viewProblem.message}</div> : null}
              {viewingQuote.customerNotes ? <div className="rounded-lg border p-4 text-sm"><p className="font-semibold text-slate-950">Notes for customer</p><p className="mt-1 whitespace-pre-wrap text-slate-700">{viewingQuote.customerNotes}</p></div> : null}
              {viewingQuote.internalNotes ? (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
                  <p className="flex items-center gap-1.5 font-semibold text-amber-900"><Lock className="size-3.5" /> Internal notes (not shown to customer)</p>
                  <p className="mt-1 whitespace-pre-wrap text-amber-950">{viewingQuote.internalNotes}</p>
                </div>
              ) : null}
              {/* Every version shares the quote's attachments, filed under its own number (068). */}
              <QuoteAttachments quoteRef={baseQuoteRef(viewingQuote.ref, viewingQuote.version)} />
              <div data-testid="quote-actions" className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
                {viewingQuote.rawStatus === "draft" ? <Button variant="outline" className="w-full sm:w-auto" onClick={() => void openFromQuote(viewingQuote, "edit")}>Edit Draft</Button> : null}
                <Button variant="outline" className="w-full sm:w-auto" onClick={() => void openFromQuote(viewingQuote, "copy")}>Copy</Button>
                {has068 && viewingQuote.rawStatus === "sent" && !viewReplacedBy ? <Button variant="outline" className="w-full sm:w-auto" disabled={saving} onClick={() => setReviseAsk(viewingQuote)}>Revise (v{viewingQuote.version + 1})</Button> : null}
                {canRecordDecision(viewingQuote.rawStatus) && !viewReplacedBy ? (
                  <>
                    <Button variant="outline" className="w-full sm:w-auto" disabled={saving} onClick={() => setDecision({ quote: viewingQuote, outcome: "rejected" })}>Mark Rejected</Button>
                    <Button variant="outline" className="w-full sm:w-auto" disabled={saving || Boolean(quoteAcceptBlock(viewingQuote.value))} title={quoteAcceptBlock(viewingQuote.value) ?? undefined} aria-describedby={quoteAcceptBlock(viewingQuote.value) ? "accept-block-reason" : undefined} onClick={() => askToAccept(viewingQuote)}>Mark Accepted</Button>
                    {quoteAcceptBlock(viewingQuote.value) ? <span id="accept-block-reason" className="sr-only">{quoteAcceptBlock(viewingQuote.value)}</span> : null}
                  </>
                ) : null}
                <Button variant="outline" className="w-full sm:w-auto" disabled={Boolean(viewProblem)} onClick={() => void downloadQuotePdf(viewingQuote)}><Download className="size-4" /> Download PDF</Button>
                {!canOfferSend(viewingQuote.rawStatus) ? null : <Button className="w-full bg-brand text-brand-ink hover:bg-brand-hover sm:w-auto" disabled={saving || Boolean(viewProblem)} onClick={() => void askToSend(viewingQuote)}><Send className="size-4" /> {saving ? "Sending…" : "Send to Customer"}</Button>}
              </div>
            </div>
          ) : null}
        <ActivityPanel table="quotes" recordId={viewingQuote?.id} className="mt-4" /></DialogContent>
      </Dialog>
      <Dialog open={Boolean(sendAsk)} onOpenChange={(open) => !open && setSendAsk(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{sendAsk ? `Send ${sendAsk.quote.ref} to ${sendAsk.email ?? sendAsk.quote.customer}?` : ""}</DialogTitle>
            <DialogDescription>
              {sendAsk?.email ? "Yes, send: your e-mail app opens addressed to them and the PDF downloads to attach." : `No e-mail address on file for ${sendAsk?.quote.customer ?? "this customer"}: your e-mail app opens for you to add one, and the PDF downloads to attach.`}
              {sendAsk?.quote.id && !DEMO_MODE ? " Email it now: sent from here with the PDF attached." : ""}
              {sendAsk?.validUntil ? ` It has no valid-until date, so it will be valid until ${fmtDate(sendAsk.validUntil)}.` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setSendAsk(null)}>Cancel</Button>
            {sendAsk?.quote.id && !DEMO_MODE ? <Button variant="outline" disabled={saving} onClick={() => { const ask = sendAsk; setSendAsk(null); if (ask) void sendQuote(ask.quote, ask.validUntil, true); }}><Mail className="size-4" /> Email it now</Button> : null}
            <Button className="bg-brand text-brand-ink hover:bg-brand-hover" disabled={saving} onClick={() => { const ask = sendAsk; setSendAsk(null); if (ask) void sendQuote(ask.quote, ask.validUntil); }}>Yes, send</Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(expiredAsk)} onOpenChange={(open) => !open && setExpiredAsk(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{expiredAsk ? `${expiredAsk.quote.ref} has expired` : ""}</DialogTitle>
            <DialogDescription>{expiredAsk?.check.message}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setExpiredAsk(null)}>Cancel</Button>
            <Button className="bg-brand text-brand-ink hover:bg-brand-hover" disabled={saving} onClick={() => { const ask = expiredAsk; setExpiredAsk(null); if (ask) { void auditEvent(expiredQuoteAuditEvent(ask.quote.ref, ask.action, ask.check)); if (ask.action === "send") void askToSend(ask.quote, true); else askToAccept(ask.quote, true); } }}>{expiredAsk?.action === "accept" ? "Mark accepted" : "Send"}</Button>
          </div>
        </DialogContent>
      </Dialog>
      <SendEmailDialog request={emailRequest} onClose={() => setEmailRequest(null)} />
      <Dialog open={Boolean(sendConfirm)} onOpenChange={(open) => !open && setSendConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Has {sendConfirm?.ref} gone to the customer?</DialogTitle>
            <DialogDescription>
              {sendConfirm?.rawStatus === "draft"
                ? "Attach the PDF and send the email first. Recording it as sent fixes the quote: it can't be edited afterwards."
                : "Attach the PDF and send the email first, then record it here."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setSendConfirm(null)}>Not yet</Button>
            <Button className="bg-brand text-brand-ink hover:bg-brand-hover" disabled={saving} onClick={() => sendConfirm && void confirmQuoteSent(sendConfirm)}>
              {saving ? "Saving\u2026" : "I\u2019ve sent it"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(reviseAsk)} onOpenChange={(open) => !open && setReviseAsk(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{reviseAsk ? `Revise ${reviseAsk.ref} as v${reviseAsk.version + 1}?` : ""}</DialogTitle>
            <DialogDescription>
              A new draft is made from it with the same quote number and the next version. {reviseAsk?.ref} is kept as it was sent, read only,
              and can no longer be accepted: only the latest version can. Change the draft, then send it.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setReviseAsk(null)}>Cancel</Button>
            <Button className="bg-brand text-brand-ink hover:bg-brand-hover" disabled={saving} onClick={() => reviseAsk && void reviseQuote(reviseAsk)}>{saving ? "Saving…" : "Revise"}</Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(poQuote)} onOpenChange={(open) => { if (!open) { setPoQuote(null); setPoDraft(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{poQuote?.customerPo ? "Change" : "Add"} the customer PO on {poQuote?.ref}</DialogTitle>
            <DialogDescription>The customer&apos;s order number, shown beside the quote number. If the quote is accepted, its job (until it is finished) and its draft invoice get it too; an invoice already issued keeps the PO it was issued with.</DialogDescription>
          </DialogHeader>
          <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void saveQuoteCustomerPo(); }}>
            <Input aria-label={CUSTOMER_PO_LABEL} placeholder="Customer order number (their PO)" maxLength={100} value={poDraft} onChange={(event) => setPoDraft(event.target.value)} />
            <Button type="submit" disabled={saving || (!poDraft.trim() && poQuote?.rawStatus !== "draft")} className="bg-brand text-brand-ink hover:bg-brand-hover">{saving ? "Saving…" : "Save customer PO"}</Button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(decision)} onOpenChange={(open) => { if (!open) { setDecision(null); setDecisionPo(""); setDecisionDue(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark {decision?.quote.ref} as {decision?.outcome}?</DialogTitle>
            <DialogDescription>
              {decision?.outcome === "accepted"
                ? "Record that the customer accepted this quote. Its job is made now if your company makes jobs automatically. This can't be undone."
                : "Record that the customer turned this quote down. This can't be undone."}
            </DialogDescription>
          </DialogHeader>
          {decision?.outcome === "accepted" ? (
            <label className="grid gap-1 text-xs text-slate-500">Customer PO (optional)
              <Input value={decisionPo} maxLength={100} placeholder="Customer order number (their PO)" onChange={(event) => setDecisionPo(event.target.value)} />
              <span>Not received yet? Leave it empty and add it on the quote when it arrives: it reaches the job and its draft invoice too.</span>
            </label>
          ) : null}
          {decision?.outcome === "accepted" ? (
            <label className="grid gap-1 text-xs text-slate-500">Due date (optional)
              <Input type="date" aria-label="Due date" value={decisionDue} className="h-11" onChange={(event) => setDecisionDue(event.target.value)} />
              <span>When the customer wants it by. It becomes the job&apos;s due date.</span>
            </label>
          ) : null}
          {has068 && decision?.outcome === "accepted" && viewItems.filter((item) => item.id).length > 1 ? (
            <fieldset className="grid gap-2 text-sm" data-testid="accept-lines">
              <legend className="mb-1 text-xs text-slate-500">Lines the customer ordered. Untick any their PO doesn&apos;t cover: only ticked lines go on the sales order, job and invoice.</legend>
              {viewItems.map((item) => item.id ? (
                <label key={item.id} className="flex items-start gap-2 pointer-coarse:min-h-11">
                  <SelectBox aria-label={`Ordered: ${item.description}`} checked={!decisionUnticked.has(item.id)} onChange={(event) => { const id = item.id!; const on = event.target.checked; setDecisionUnticked((current) => { const next = new Set(current); if (on) next.delete(id); else next.add(id); return next; }); }} />
                  <span className="min-w-0 flex-1"><span className="block truncate">{item.description}</span>{lineReference(item) ? <span className="block text-xs text-slate-500">{lineReference(item)}</span> : null}</span>
                  <span className="tabular-nums">{currency(documentTotals([{ quantity: item.quantity, unitPrice: item.unitPrice, vatPct: 0 }]).subtotal)}</span>
                </label>
              ) : null)}
              <p className="text-right text-xs text-slate-600" data-testid="accept-lines-total">
                Ordered: {currency(documentTotals(viewItems.filter((item) => item.id && !decisionUnticked.has(item.id)).map((item) => ({ quantity: item.quantity, unitPrice: item.unitPrice, vatPct: 0 }))).subtotal)} ex VAT
                {decisionUnticked.size ? ` (${viewItems.filter((item) => item.id).length - decisionUnticked.size} of ${viewItems.filter((item) => item.id).length} lines)` : ""}
              </p>
            </fieldset>
          ) : null}
          {decision?.outcome === "accepted" && acceptedLinesBlock ? <p id="accept-lines-block" role="alert" className="text-sm text-red-700">{acceptedLinesBlock}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setDecision(null); setDecisionPo(""); setDecisionDue(""); }}>Cancel</Button>
            <Button className="bg-brand text-brand-ink hover:bg-brand-hover" disabled={saving || Boolean(decision?.outcome === "accepted" && acceptedLinesBlock)} aria-describedby={decision?.outcome === "accepted" && acceptedLinesBlock ? "accept-lines-block" : undefined} onClick={() => decision && void recordDecision(decision.quote, decision.outcome)}>
              {saving ? "Saving…" : decision?.outcome === "accepted" ? "Confirm Accepted" : "Confirm Rejected"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
    </RoleGate>
  );
}
