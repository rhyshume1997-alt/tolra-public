"use client";

import { ActivityPanel } from "@/components/activity-panel";
import { EmptyList } from "@/components/empty-list";
import { deliveryNotesEmptyHint } from "@/lib/empty-hints";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { PenLine, Plus, Truck, type LucideIcon } from "lucide-react";

import { FilterBar } from "@/components/filter-bar";
import { ArchiveButton, PhaseFilter } from "@/components/phase-filter";
import { phaseOf, type PhaseFilterValue, useArchive } from "@/lib/archive";
import { ColumnToggle } from "@/components/column-toggle";
import { ViewSwitcher } from "@/components/view-switcher";
import { useViewMode } from "@/lib/view-mode";
import { RoleGate } from "@/components/role-gate";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/status-badge";
import { deliveryNoteStatusKey } from "@/lib/status-colours";
import { Button } from "@/components/ui/button";
import { SelectBox } from "@/components/ui/select-box";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { CertPack } from "@/components/cert-pack";
import { DocumentAttachments } from "@/components/document-attachments";
import { DeliveryNoteInvoiceLink } from "@/components/delivery-note-invoice-link";
import { DespatchFromOrder } from "@/components/despatch-from-order";
import { CustomerSelect } from "@/components/customer-select";
import { auditEvent } from "@/lib/audit";
import { type TemplateVars, renderTemplate } from "@/lib/email/templates/defaults";
import { loadTemplateOverride } from "@/lib/email/templates/store";
import { requireCompanyProfile, useCompanyProfile } from "@/lib/company";
import { resolveCustomer, resolveCustomerAddress } from "@/lib/customers";
import { deliveryNoteCustomerSignOff } from "@/lib/customer-signoff-print";
import { DEMO_MODE } from "@/lib/demo";
import { ListFilterNotice, useListFilter } from "@/components/list-filter-notice";
import { deliveryNoteMatchesFilter } from "@/lib/list-filter";
import { AWAITING_SIGNATURE_LABEL, AWAITING_SIGNATURE_STATUSES, countAwaitingSignature } from "@/lib/list-card-counts";
import { fmtDate, fmtDateTime, nowIso, toDateInput } from "@/lib/dates";
import { downloadPdf, pdfBlob } from "@/lib/download-pdf";
import { type SendEmailRequest, SendEmailDialog } from "@/components/email/send-email-button";
import { friendlyError } from "@/lib/friendly-error";
import { draftedInvoiceId, invoiceHref } from "@/lib/invoice-link";
import { esc } from "@/lib/html";
import { deliveryNoteNumberForInvoice } from "@/lib/numbering";
import { openPrintPack } from "@/lib/print-pack";
import { useColumnVisibility } from "@/lib/org-settings";
import { confirmPageCompany } from "@/lib/page-company";
import { supabase } from "@/lib/supabase";
import { JobPicker } from "@/components/job-picker";
import { type PickerJob, jobSurvivesCustomerChange } from "@/lib/job-picker";
import { useUser } from "@/lib/use-user";
import { useSaving } from "@/lib/use-saving";
import { ValidationError, deliveryNoteEditSchema, deliveryNoteSaveSchema, parseOrThrow, signatureSchema, userMessage } from "@/lib/validation/schemas";
import { fetchAll, truncationNotice } from "@/lib/fetch-all";
import { type NoteSource, defaultNoteSource } from "@/lib/delivery-note-source";
import { REASON_LABEL, isMissingFunction, toUninvoiced } from "@/lib/uninvoiced";

const DN_FILTER_LABELS: Record<string, string> = { "awaiting-old": "Delivery notes awaiting for over a day", "not-invoiced": "Delivery notes despatched with no invoice" };

type DeliveryNoteRow = {
  /** Database UUID. Demo rows use their reference. */
  id: string;
  ref: string;
  customer: string;
  email: string;
  job: string;
  /** ISO delivery date (YYYY-MM-DD) or timestamp. */
  date: string;
  status: string;
  signed_by_name: string;
  /** ISO timestamp. */
  signed_at: string;
  signature_notes: string;
  /** ISO timestamp. */
  emailed_at: string;
  invoiceRef?: string;
  /** The invoice the note is on (migration 034; a draft made automatically when it went out, 059). */
  invoiceId?: string;
  createdAt?: string;
  updatedAt?: string;
  taxDate?: string;
  shipDate?: string;
  shipVia?: string;
  items?: Array<{ description: string; quantity: number }>;
  /** True for sample rows that exist only in demo mode. */
  demo?: boolean;
};

/** "2026-10-08" -> an ISO timestamp at local noon, so it shows as the same day in UK time. */
const dateToIso = (day: string) => new Date(`${day}T12:00:00`).toISOString();

/** Demo mode only. JNR's real records are imported lazily so they never ship in the production bundle. */
async function loadDemoNotes(): Promise<DeliveryNoteRow[]> {
  const m = await import("@/lib/jnr-test-data");
  return m.JNR_TEST_DELIVERY_NOTES.map((note): DeliveryNoteRow => ({ id: note.ref, demo: true, ref: note.ref, customer: note.customer, email: note.email, job: note.jobNo, date: note.shipDate, status: note.status, signed_by_name: "", signed_at: "", signature_notes: "", emailed_at: "", invoiceRef: note.invoiceRef, taxDate: note.taxDate, shipDate: note.shipDate, shipVia: note.shipVia, items: note.items }));
}

/** "Flange x 10", "Flange | 10" or just "Flange" (quantity 1). */
function parseItemLine(line: string) {
  const match = /^(.*\S)\s+[x×]\s*(\d+(?:\.\d+)?)$/i.exec(line) ?? /^(.*\S)\s*\|\s*(\d+(?:\.\d+)?)$/.exec(line);
  return { description: (match?.[1] ?? line).trim(), quantity: match ? Number(match[2]) : 1 };
}

export default function DeliveryNotesPage() {
  const { isVisible } = useColumnVisibility("delivery-notes");
  // Cards / List / Table, remembered per person (lib/view-mode; styles in app/globals.css [data-view]). Table is the page as it was.
  const [view, setView] = useViewMode("delivery-notes", "table");
  const { profile: company } = useCompanyProfile();
  const { activeRole, hiddenSections } = useUser();
  // E-mail history belongs to admin and office; workshop staff keep despatch and signature work.
  const canEmail = activeRole === "admin" || activeRole === "office";
  // Putting a note on a draft invoice (067): admin and office with Invoicing shown, as link_delivery_note_to_invoice requires.
  const canLinkInvoice = canEmail && !hiddenSections.includes("invoices");
  const { saving, run } = useSaving();
  const router = useRouter();
  const [notes, setNotes] = useState<DeliveryNoteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filters, setFilters] = useState(new Set(["all"]));
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [viewing, setViewing] = useState<DeliveryNoteRow | null>(null);
  const [editing, setEditing] = useState<DeliveryNoteRow | null>(null);
  const [editDraft, setEditDraft] = useState({ customer: "", job: "", date: "", shipDate: "", taxDate: "", shipVia: "" });
  const [emailing, setEmailing] = useState<DeliveryNoteRow | null>(null);
  const [emailRequest, setEmailRequest] = useState<SendEmailRequest | null>(null);
  const [signingIds, setSigningIds] = useState<string[]>([]);
  const [newOpen, setNewOpen] = useState(false);
  // Where a new note comes from (migration 034): a sales order, a job, or by hand with no order behind it.
  // The form opens on "From a job" for the workshop, and for admin and office once a job made from an order exists (the same jobs the form lists);
  // a choice made on the form is kept until the page is left.
  const [jobsExist, setJobsExist] = useState(false);
  const [chosenSource, setNoteSource] = useState<NoteSource | null>(null);
  const noteSource = chosenSource ?? defaultNoteSource(activeRole, jobsExist);
  // "Without an order": the job is picked from this company's jobs (never typed), and picking one fills the customer from it.
  const [manualJob, setManualJob] = useState<PickerJob | null>(null);
  const [manualCustomer, setManualCustomer] = useState("");
  /** Picking a job fills the customer from it (cleared when the job has none); picking none changes nothing. */
  function pickManualJob(job: PickerJob | null) {
    setManualJob(job);
    if (job) setManualCustomer(job.customer);
  }
  /** Changing the customer to another one drops the picked job. */
  function changeManualCustomer(name: string) {
    setManualCustomer(name);
    if (manualJob && !jobSurvivesCustomerChange(manualJob, name)) setManualJob(null);
  }
  useEffect(() => {
    if (!supabase || !canEmail) return;
    let active = true;
    void supabase.from("jobs").select("id", { count: "exact", head: true }).not("converted_from_sales_order_id", "is", null)
      .then(({ count }) => { if (active) setJobsExist((count ?? 0) > 0); });
    return () => { active = false; };
  }, [canEmail]);
  // Open / Done / Archived (lib/archive, migration 028): finished records move out of the way; nothing is deleted.
  const archive = useArchive("delivery_notes");
  const [phase, setPhase] = useState<PhaseFilterValue>("open");
  // /delivery-notes?filter=awaiting-old|not-invoiced (the dashboard's "View all"): only those notes, whatever Show says.
  const [listFilter, clearListFilter] = useListFilter("delivery-notes");
  const phaseFor = useCallback((note: (typeof notes)[number]) => phaseOf({ final: ["delivered", "signed"].includes(note.status), finalDate: note.signed_at || note.date }, note.id ? archive.manual.get(String(note.id)) : undefined, archive.months), [archive.manual, archive.months]);
  const phaseCounts = useMemo(() => ({ open: notes.filter((x) => phaseFor(x) === "open").length, done: notes.filter((x) => phaseFor(x) === "done").length, archived: notes.filter((x) => phaseFor(x) === "archived").length }), [notes, phaseFor]);
  const visible = useMemo(() => notes.filter((note) => (listFilter ? deliveryNoteMatchesFilter(listFilter, note, toDateInput(new Date())) : (phase === "all" || phaseFor(note) === phase) && (filters.has("all") || filters.has(note.status)))), [filters, listFilter, notes, phase, phaseFor]);
  const signingNotes = notes.filter((note) => signingIds.includes(note.id));

  // Stat cards come from the loaded notes.
  const stats = useMemo(() => {
    const today = toDateInput(new Date());
    const weekAgo = toDateInput(new Date(Date.now() - 7 * 86400000));
    const month = today.slice(0, 7);
    const sentOut = (status: string) => status === "despatched" || status === "delivered" || status === "signed";
    return {
      week: notes.filter((note) => sentOut(note.status) && toDateInput(note.date) >= weekAgo && toDateInput(note.date) <= today).length,
      signedMonth: notes.filter((note) => note.status === "signed" && toDateInput(note.signed_at || note.date).slice(0, 7) === month).length,
      awaitingSignature: countAwaitingSignature(notes),
    };
  }, [notes]);

  const loadNotes = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      if (!supabase) throw new Error("Supabase is not configured.");
      // Every row, page by page (lib/fetch-all): the API returns at most 1,000 per request.
        const { rows: data, truncated } = await fetchAll((from, to) => supabase!.from("delivery_notes").select("*").order("delivery_date", { ascending: false }).order("id").range(from, to));
        const error = null;
        if (truncated) toast.warning(truncationNotice(data.length));
      if (error) throw error;
      // Trust the database, including an empty result.
      setNotes((data ?? []).map((row): DeliveryNoteRow => ({
        id: String(row.id),
        ref: row.dn_number || row.dn_ref || `DN-${String(row.id).slice(0, 8)}`,
        customer: row.customer || row.customer_name || "",
        email: row.customer_email || "",
        job: row.job_ref || "",
        date: row.delivery_date || row.ship_date || row.created_at || "",
        status: row.status || "pending",
        signed_by_name: row.signed_by_name || "",
        signed_at: row.signed_at || "",
        signature_notes: row.signature_notes || "",
        emailed_at: row.emailed_at || "",
        invoiceRef: row.invoice_ref || "",
        invoiceId: row.invoice_id ? String(row.invoice_id) : undefined,
        createdAt: row.created_at ? String(row.created_at) : undefined,
        updatedAt: row.updated_at ? String(row.updated_at) : undefined,
        taxDate: row.tax_date || "",
        shipDate: row.ship_date || row.delivery_date || "",
        shipVia: row.ship_via || "",
      })));
    } catch (err) {
      setLoadError(friendlyError(err, "Couldn't load delivery notes."));
      setNotes(DEMO_MODE ? await loadDemoNotes() : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadNotes(); }, [loadNotes]);

  /**
   * What happened to the invoice of each sent-out note (admin and office, who see invoices): "Draft invoice created", "Invoiced INV-x",
   * or why it isn't invoiced, from uninvoiced_delivery_notes() (migration 059). Read again whenever a note's status changes.
   */
  const [invoiceState, setInvoiceState] = useState<Map<string, { label: string; detail?: string; attention: boolean; invoiceId?: string }>>(new Map());
  const sentKey = useMemo(() => notes.filter((note) => !note.demo && ["despatched", "delivered", "signed"].includes(note.status)).map((note) => note.id).join(","), [notes]);
  useEffect(() => {
    if (!canEmail || !supabase || !sentKey) return;
    let active = true;
    void (async () => {
      const ids = sentKey.split(",");
      const states = new Map<string, { label: string; detail?: string; attention: boolean; invoiceId?: string }>();
      // The note's invoice, read from the database (a draft made by the database is not known on screen yet).
      const links = new Map<string, string>();
      for (let i = 0; i < ids.length; i += 100) {
        const { data } = await supabase!.from("delivery_notes").select("id, invoice_id").in("id", ids.slice(i, i + 100));
        for (const row of data ?? []) if (row.invoice_id) links.set(String(row.id), String(row.invoice_id));
      }
      const invoiceIds = [...new Set(links.values())];
      const invoices = new Map<string, { status: string; ref: string | null }>();
      for (let i = 0; i < invoiceIds.length; i += 100) {
        const { data } = await supabase!.from("invoices").select("id, status, invoice_ref").in("id", invoiceIds.slice(i, i + 100));
        for (const row of data ?? []) invoices.set(String(row.id), { status: String(row.status ?? "draft"), ref: row.invoice_ref ? String(row.invoice_ref) : null });
      }
      for (const [noteId, invoiceId] of links) {
        const invoice = invoices.get(invoiceId);
        if (!invoice || ["void", "voided", "cancelled", "canceled"].includes(invoice.status.toLowerCase())) continue;
        states.set(noteId, invoice.status === "draft" ? { label: "Draft invoice created", detail: "Waiting for a person to issue it (Invoicing).", attention: false, invoiceId } : { label: `Invoiced ${invoice.ref ?? ""}`.trim(), attention: false, invoiceId });
      }
      const { data, error } = await supabase!.rpc("uninvoiced_delivery_notes");
      if (error && !isMissingFunction(error)) console.error(error);
      for (const row of ((data ?? []) as Record<string, unknown>[]).map(toUninvoiced)) states.set(row.id, { label: REASON_LABEL[row.reason], detail: row.detail, attention: row.reason !== "internal-job" });
      if (active) setInvoiceState(states);
    })();
    return () => { active = false; };
  }, [canEmail, sentKey]);

  /** Writes columns to one or more delivery notes, then mirrors them on screen. Throws on failure. */
  async function persistNotes(targets: DeliveryNoteRow[], columns: Record<string, unknown>, patch: Partial<DeliveryNoteRow>) {
    const real = targets.filter((note) => !note.demo);
    if (real.length) {
      if (!supabase) throw new Error("Supabase is not configured.");
      const { error } = await supabase.from("delivery_notes").update(columns).in("id", real.map((note) => note.id));
      if (error) throw error;
    } else if (targets.length && !DEMO_MODE) {
      throw new Error("Supabase is not configured.");
    }
    const ids = targets.map((note) => note.id);
    setNotes((current) => current.map((note) => ids.includes(note.id) ? { ...note, ...patch } : note));
  }

  async function markSentOut(note: DeliveryNoteRow) {
    await run(async () => {
      try {
        await persistNotes([note], { status: "despatched" }, { status: "despatched" });
        void auditEvent({ action: "DESPATCH", entityTable: "delivery_notes", entityId: note.id, newData: { status: "despatched" } });
        // When sending it out made a draft invoice (migration 059; the trigger runs in the same update), offer to open it. Reading it back
        // is best effort and admin/office only (their policy): any failure just leaves the plain message.
        let draftId: string | null = null;
        if (canEmail && supabase && !note.demo) {
          try {
            const { data } = await supabase.from("invoice_queue_events").select("outcome, invoice_id").eq("delivery_note_id", note.id).eq("outcome", "drafted")
              .not("invoice_id", "is", null).order("created_at", { ascending: false }).limit(1);
            draftId = draftedInvoiceId(data);
          } catch {
            draftId = null;
          }
        }
        toast.success(`${note.ref} marked as despatched`, draftId ? { duration: 12_000, action: { label: "Open draft invoice", onClick: () => router.push(invoiceHref(draftId!)) } } : undefined);
      } catch (err) {
        toast.error(userMessage(err, "Could not mark delivery note as despatched"));
      }
    });
  }

  function toggleSelected(id: string) {
    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  function printSelected() {
    if (!selectedIds.length) {
      toast.error("Select at least one delivery note to print.");
      return;
    }
    if (!company) {
      toast.error("Company details aren't set up. An admin can add them in Settings.");
      return;
    }
    const selected = notes.filter((note) => selectedIds.includes(note.id));
    const opened = openPrintPack(`${company.name} Delivery Note Pack`, selected.map((note) => `<section><h2>${esc(note.ref)}</h2><table><tr><th>Customer</th><td>${esc(note.customer)}</td></tr><tr><th>Job</th><td>${esc(note.job || "No linked job")}</td></tr><tr><th>Delivery Date</th><td>${esc(fmtDate(note.date))}</td></tr><tr><th>Status</th><td>${esc(note.status)}</td></tr></table><p>Signed by: __________________ Date: __________</p></section>`), "delivery_notes");
    if (!opened) {
      toast.error("Allow pop-ups to print.");
      return;
    }
    toast.success(`Preparing ${selected.length} delivery note print pack`);
  }

  async function markSigned(selectedTargets: DeliveryNoteRow[], form: FormData) {
    // A signed note keeps its signature (migration 034): leave those out of a bulk signing.
    const targets = selectedTargets.filter((note) => note.status !== "signed");
    await run(async () => {
      try {
        if (!targets.length) throw new ValidationError(selectedTargets.length ? "Those delivery notes are already signed." : "Select at least one delivery note first.");
        const input = parseOrThrow(signatureSchema, {
          signedByName: String(form.get("signed_by_name") || ""),
          signedAt: String(form.get("signed_at") || ""),
          signatureNotes: String(form.get("signature_notes") || ""),
        });
        const signedAt = dateToIso(input.signedAt);
        await persistNotes(
          targets,
          { status: "signed", signed_by_name: input.signedByName, signed_at: signedAt, signature_notes: input.signatureNotes || null },
          { status: "signed", signed_by_name: input.signedByName, signed_at: signedAt, signature_notes: input.signatureNotes },
        );
        void auditEvent({ action: "MARK_SIGNED", entityTable: "delivery_notes", metadata: { ids: targets.map((note) => note.id), signed_by: input.signedByName } });
        setSelectedIds([]);
        setViewing(null);
        setSigningIds([]);
        setFilters(new Set(["signed"]));
        setPhase("done"); // it moved to Done: show it there
        toast.success(`${targets.length} delivery note(s) moved to Signed`);
      } catch (err) {
        toast.error(userMessage(err, "Could not mark delivery note as signed"));
      }
    });
  }

  function markSelectedSigned() {
    if (!selectedIds.length) {
      toast.error("Select at least one delivery note first.");
      return;
    }
    setSigningIds(selectedIds);
  }

  function startEdit(note: DeliveryNoteRow) {
    setEditDraft({ customer: note.customer, job: note.job, date: toDateInput(note.date), shipDate: toDateInput(note.shipDate), taxDate: toDateInput(note.taxDate), shipVia: note.shipVia || "" });
    setEditing(note);
  }

  async function saveEdit() {
    const note = editing;
    if (!note) return;
    await run(async () => {
      try {
        const input = parseOrThrow(deliveryNoteEditSchema, editDraft);
        const shipDate = input.shipDate || input.date;
        await persistNotes(
          [note],
          { customer: input.customer, job_ref: input.job || null, delivery_date: input.date, ship_date: shipDate, tax_date: input.taxDate || null, ship_via: input.shipVia || null },
          { customer: input.customer, job: input.job, date: input.date, shipDate, taxDate: input.taxDate, shipVia: input.shipVia },
        );
        void auditEvent({ action: "UPDATE", entityTable: "delivery_notes", entityId: note.id, newData: input });
        setEditing(null);
        toast.success(`${note.ref} updated`);
      } catch (err) {
        toast.error(userMessage(err, "Could not update delivery note"));
      }
    });
  }

  async function openEmail(note: DeliveryNoteRow) {
    // Use the email stored on the note, otherwise the customer's email from the customers list.
    const email = note.email || (await resolveCustomer(note.customer))?.email || "";
    setEmailing({ ...note, email });
  }

  /** History and (only when confirmed sent) the note's e-mailed time, in one transaction (migration 026). */
  async function logEmail(note: DeliveryNoteRow, subject: string, body: string, status: "copied" | "sent_manually") {
    if (!note.email) throw new ValidationError("There's no email address for this customer. Add one on the Customers page first.");
    if (!supabase || note.demo) {
      const sentAt = status === "sent_manually" ? nowIso() : "";
      if (sentAt) setNotes((current) => current.map((row) => row.id === note.id ? { ...row, emailed_at: sentAt } : row));
      return sentAt;
    }
    const { data, error } = await supabase.rpc("log_delivery_note_email", { p_note: note.id, p_to: note.email, p_subject: subject, p_body: body, p_status: status });
    if (error) throw error;
    const sentAt = typeof data === "string" ? data : "";
    if (sentAt) setNotes((current) => current.map((row) => row.id === note.id ? { ...row, emailed_at: sentAt } : row));
    return sentAt;
  }

  async function copyEmail(note: DeliveryNoteRow, subject: string, body: string) {
    await run(async () => {
      try {
        await navigator.clipboard.writeText(body);
        await logEmail(note, subject, body, "copied");
        void auditEvent({ action: "EMAIL_COPIED", entityTable: "email_history", entityId: note.ref, newData: { to: note.email, subject, status: "copied" } });
        toast.success("Email body copied. Mark it as sent once you\u2019ve sent it.");
      } catch (err) {
        toast.error(userMessage(err, "Could not copy the email."));
      }
    });
  }

  async function markEmailSent(note: DeliveryNoteRow, subject: string, body: string) {
    await run(async () => {
      try {
        const sentAt = await logEmail(note, subject, body, "sent_manually");
        void auditEvent({ action: "EMAIL_SENT_MANUALLY", entityTable: "email_history", entityId: note.ref, newData: { to: note.email, subject, status: "sent_manually", sent_at: sentAt } });
        setEmailing(null);
        toast.success(`${note.ref} marked as sent`);
      } catch (err) {
        toast.error(userMessage(err, "Could not mark email as sent"));
      }
    });
  }

  async function fetchNoteItems(note: DeliveryNoteRow) {
    if (note.items?.length) return note.items;
    if (!supabase || note.demo) return [];
    const { data, error } = await supabase.from("delivery_note_items").select("description, quantity").eq("delivery_note_id", note.id).order("position");
    if (error) throw error;
    return (data ?? []).map((row) => ({ description: String(row.description || ""), quantity: Number(row.quantity || 0) }));
  }

  async function downloadDeliveryNotePdf(note: DeliveryNoteRow) {
    await downloadPdf(() => buildDeliveryNotePdf(note), `delivery-note-${note.ref}.pdf`, { entityTable: "delivery_notes", entityId: note.ref });
  }

  /** One-click send (E8) from the e-mail editor: the PDF attached; once it has gone, the note's e-mailed time is stamped. */
  function sendEmailNow(note: DeliveryNoteRow, subject: string, body: string) {
    if (!company) return;
    if (note.demo || !supabase) return void toast.error("Sending isn't available in the demo. Open it in your email client instead.");
    setEmailing(null);
    setEmailRequest({
      kind: "delivery_note", recordId: note.id, templateKey: "delivery_note", to: note.email, vars: deliveryNoteEmailVars(note, company.name), initial: { subject, body },
      pdf: { filename: `delivery-note-${note.ref}.pdf`, build: async () => pdfBlob(await buildDeliveryNotePdf(note)) },
      onSent: () => void stampEmailed(note),
    });
  }

  async function stampEmailed(note: DeliveryNoteRow) {
    if (!supabase) return;
    const sentAt = nowIso();
    const { error } = await supabase.from("delivery_notes").update({ emailed_at: sentAt }).eq("id", note.id);
    if (error) return void toast.info(`${note.ref} was sent, but its e-mailed time couldn't be recorded. It is in Email history.`);
    setNotes((current) => current.map((row) => row.id === note.id ? { ...row, emailed_at: sentAt } : row));
  }

  /** The delivery note's PDF element (Download and the one-click send attach the same). */
  async function buildDeliveryNotePdf(note: DeliveryNoteRow) {
    const profile = await requireCompanyProfile();
    const items = await fetchNoteItems(note);
    if (!items.length) throw new ValidationError("This delivery note has no items, so there is nothing to print.");
    const billTo = await resolveCustomerAddress(note.customer);
    const shipDate = note.shipDate || note.date;
    // The job's customer sign-off (072), when it has one; none (or 072 not applied) leaves the note as it was.
    const customerSignOff = supabase && !note.demo ? await deliveryNoteCustomerSignOff(supabase, note.id) : undefined;
    // The PDF code is loaded when a PDF is made, not with the page.
    const { DeliveryNotePDF } = await import("@/components/pdf/DeliveryNotePDF");
    return (
      <DeliveryNotePDF
        data={{
          number: note.ref,
          taxDate: fmtDate(note.taxDate || shipDate),
          shipDate: fmtDate(shipDate),
          shipVia: note.shipVia,
          billTo,
          items,
          customerSignOff,
          company: profile,
        }}
      />
    );
  }

  /** A note made by hand: with an invoice number it takes that number (INV-0456 -> DLN-0456), without one the next DLN number. */
  async function createNote(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    await run(async () => {
      try {
        if (!supabase) throw new Error("Supabase is not configured.");
        const input = parseOrThrow(deliveryNoteSaveSchema, {
          customer: String(form.get("customer") || ""),
          invoiceRef: String(form.get("invoice_ref") || "").trim().toUpperCase().replace(/^INV\s*(\d)/, "INV-$1"),
          job: String(form.get("job") || ""),
          shipDate: String(form.get("ship_date") || ""),
          taxDate: String(form.get("tax_date") || ""),
          notes: String(form.get("notes") || ""),
          items: String(form.get("items") || "").split("\n").map((line) => line.trim()).filter(Boolean).map(parseItemLine),
        });
        // next_doc_number and create_with_lines file it in the session's company: refused if another tab switched it since this page
        // opened (S5).
        await confirmPageCompany(supabase);
        let ref: string;
        if (input.invoiceRef) {
          try {
            ref = deliveryNoteNumberForInvoice(input.invoiceRef);
          } catch {
            throw new ValidationError("Enter an invoice number like INV-0456, or leave it empty.");
          }
        } else {
          // No invoice yet: the next number in the delivery note series (DLN-0001, ...).
          const { data: next, error: numberError } = await supabase.rpc("next_doc_number", { p_prefix: "DLN" });
          if (numberError) throw numberError;
          ref = String(next);
        }
        if (notes.some((note) => note.ref === ref)) throw new ValidationError(`${ref} already exists.`);
        const { error } = await supabase.rpc("create_with_lines", {
          p_parent: "delivery_notes",
          p_header: {
            dn_number: ref,
            customer: input.customer,
            invoice_ref: input.invoiceRef || null,
            job_ref: input.job || null,
            delivery_date: input.shipDate,
            ship_date: input.shipDate,
            tax_date: input.taxDate,
            status: "awaiting",
            notes: input.notes || null,
          },
          p_child: "delivery_note_items",
          p_fk: "delivery_note_id",
          p_lines: input.items.map((item, position) => ({ position, description: item.description, quantity: item.quantity })),
        });
        if (error) throw error;
        void auditEvent({ action: "CREATE", entityTable: "delivery_notes", entityId: ref });
        toast.success(`Delivery note ${ref} created`);
        // Reset and close only after a successful save.
        formEl.reset();
        setManualJob(null);
        setManualCustomer("");
        setNewOpen(false);
        void loadNotes();
      } catch (err) {
        toast.error(userMessage(err, "Could not create delivery note. Nothing was saved."));
      }
    });
  }

  const today = toDateInput(new Date());

  return (
    <RoleGate allowed={["admin", "office", "workshop"]}>
      <div className="space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div><h1 className="page-title">Delivery Notes</h1><p className="mt-2 text-sm text-slate-500">A delivery note goes with finished work. Despatch means sending finished work to the customer.</p></div>
          <Dialog open={newOpen} onOpenChange={setNewOpen}>
            <DialogTrigger asChild><Button className="min-h-11 bg-brand text-brand-ink hover:bg-brand-hover"><Plus className="size-4" /> New delivery note</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>New Delivery Note</DialogTitle><DialogDescription>Make it from a sales order or a job, with the quantity despatched on each line, or by hand. No invoice is needed first.</DialogDescription></DialogHeader>
              <div role="group" aria-label="Where the delivery note comes from" className="flex flex-wrap gap-2">
                {([["order", "From a sales order"], ["job", "From a job"], ["manual", "Without an order"]] as const)
                  .filter(([value]) => value !== "order" || activeRole !== "workshop")
                  .map(([value, text]) => (
                    <Button key={value} type="button" size="sm" variant={noteSource === value ? "default" : "outline"} aria-pressed={noteSource === value} onClick={() => setNoteSource(value)}>{text}</Button>
                  ))}
              </div>
              {noteSource === "manual" ? (
              <form onSubmit={createNote} className="grid gap-3">
                <Input name="invoice_ref" maxLength={20} placeholder="Invoice number, if there is one (for example INV-0456)" />
                <JobPicker name="job" selected={manualJob} active={newOpen && noteSource === "manual"} includeInternal valueIs="job_no" emptyLabel="No job (optional)" onPick={pickManualJob} />
                <CustomerSelect name="customer" required value={manualCustomer} onValueChange={changeManualCustomer} />
                <div className="grid gap-3 md:grid-cols-2"><label className="grid gap-1 text-sm text-slate-600">Ship date<Input name="ship_date" type="date" required defaultValue={today} /></label><label className="grid gap-1 text-sm text-slate-600">Tax date<Input name="tax_date" type="date" required defaultValue={today} /></label></div>
                <Textarea name="items" placeholder={"Items, one per line: description x quantity\nSpacer, 25 mm x 10"} required />
                <Textarea name="notes" maxLength={2000} placeholder="Notes" />
                <Button type="submit" disabled={saving} className="bg-brand text-brand-ink">{saving ? "Saving…" : "Save Delivery Note"}</Button>
              </form>
              ) : (
                <DespatchFromOrder source={noteSource} onCreated={() => { setNewOpen(false); void loadNotes(); }} />
              )}
            </DialogContent>
          </Dialog>
        </div>
        {DEMO_MODE ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Demo mode: sample data is shown if the database can&apos;t be reached.</div> : null}
        <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setSelectedIds(visible.map((note) => note.id))}>{`Select all ${visible.length} filtered`}</Button><Button variant="outline" onClick={() => setSelectedIds([])}>Clear selection</Button><span role="status" aria-live="polite" className="self-center text-sm text-slate-600 dark:text-slate-300"><strong className="font-semibold text-ink">{selectedIds.length} selected</strong> of {visible.length} filtered {visible.length === 1 ? "record" : "records"}</span><Button onClick={printSelected} disabled={!selectedIds.length} title={selectedIds.length ? undefined : "Select at least one delivery note"} className="bg-brand text-brand-ink">Print Selected</Button><Button variant="outline" disabled={saving || !selectedIds.length} title={selectedIds.length ? undefined : "Select at least one delivery note"} onClick={markSelectedSigned}>Mark Selected Signed</Button></div>
        <div className="grid gap-4 md:grid-cols-3">
          {([
            ["Despatched This Week", stats.week, ["despatched", "delivered", "signed"], Truck, "text-brand-accent"],
            ["Signed This Month", stats.signedMonth, ["signed"], PenLine, "text-green-600 dark:text-green-400"],
            [AWAITING_SIGNATURE_LABEL, stats.awaitingSignature, AWAITING_SIGNATURE_STATUSES, Truck, "text-orange-600 dark:text-orange-400"],
          ] as readonly (readonly [string, number, readonly string[], LucideIcon, string])[]).map(([label, value, filter, Icon, tone]) => (
            <Card key={label} className="cursor-pointer transition hover:bg-slate-50" onClick={() => setFilters(new Set(filter))}>
              <CardContent className="p-5"><Icon className={`size-5 ${tone}`} /><p className="mt-3 text-sm text-slate-500">{label}</p><p className="text-3xl font-bold">{loading ? "—" : value}</p></CardContent>
            </Card>
          ))}
        </div>
        {listFilter ? <ListFilterNotice label={DN_FILTER_LABELS[listFilter] ?? listFilter} onClear={clearListFilter} /> : null}
      <div className="flex flex-wrap items-start justify-between gap-2"><PhaseFilter value={phase} onChange={setPhase} counts={phaseCounts} />
        <FilterBar activeValues={[...filters]} options={[{ label: "All", value: "all" }, { label: "Awaiting", value: "awaiting" }, { label: "Despatched", value: "despatched" }, { label: "Delivered", value: "delivered" }, { label: "Signed", value: "signed" }]} onChange={setFilters} /><ColumnToggle tableKey="delivery-notes" /><ViewSwitcher value={view} onChange={setView} /></div>
        {loadError ? (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <span>{loadError}</span>
            <Button variant="outline" size="sm" onClick={() => void loadNotes()}>Retry</Button>
          </div>
        ) : null}
        {loading ? <div className="space-y-3"><Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" /></div> : loadError && !DEMO_MODE ? null : visible.length === 0 ? (
          <EmptyList
            title={notes.length ? "No delivery notes match this filter" : "No delivery notes yet"}
            hint={notes.length ? "Try a different filter." : deliveryNotesEmptyHint()}
            hintTestId={notes.length ? undefined : "empty-hint"}
            action={notes.length ? <Button variant="outline" onClick={() => setFilters(new Set(["all"]))}>Show all</Button> : <Button className="bg-brand text-brand-ink hover:bg-brand-hover" onClick={() => setNewOpen(true)}><Plus className="size-4" /> New delivery note</Button>}
          />
        ) : (
          <Card><CardContent className="p-0"><Table data-view={view}>
            <TableHeader className="hidden md:table-header-group"><TableRow>
              <TableHead><SelectBox aria-label={`Select all ${visible.length} filtered delivery notes`} checked={selectedIds.length === visible.length && visible.length > 0} onChange={(event) => setSelectedIds(event.target.checked ? visible.map((note) => note.id) : [])} /></TableHead>
              {isVisible("ref") ? <TableHead>DN Ref</TableHead> : null}{isVisible("customer") ? <TableHead>Customer</TableHead> : null}{isVisible("job") ? <TableHead>Job Ref</TableHead> : null}{isVisible("date") ? <TableHead>Delivery Date</TableHead> : null}{isVisible("status") ? <TableHead>Status</TableHead> : null}{isVisible("email") ? <TableHead>Email</TableHead> : null}<TableHead>Actions</TableHead>
            </TableRow></TableHeader>
            <TableBody>{visible.map((note) => (
              <TableRow key={note.id} className={note.status === "signed" ? "block bg-green-50 md:table-row" : "block md:table-row"}>
                <TableCell className="block md:table-cell"><SelectBox aria-label={`Select ${note.ref}`} checked={selectedIds.includes(note.id)} onChange={() => toggleSelected(note.id)} /></TableCell>
                {isVisible("ref") ? <TableCell data-label="DN Ref" className="block font-mono font-semibold md:table-cell">{note.ref}</TableCell> : null}
                {isVisible("customer") ? <TableCell data-label="Customer" className="block md:table-cell">{note.customer || "Customer not linked"}</TableCell> : null}
                {isVisible("job") ? <TableCell data-label="Job Ref" className="block md:table-cell">{note.job || "No linked job"}</TableCell> : null}
                {isVisible("date") ? <TableCell data-label="Delivery Date" className="block md:table-cell">{fmtDate(note.date)}</TableCell> : null}
                {isVisible("status") ? <TableCell data-label="Status" className="block md:table-cell"><StatusBadge status={deliveryNoteStatusKey(note.status)} label={note.status} className="capitalize" />{note.signed_at ? <p className="mt-1 text-xs text-slate-500">Signed {fmtDate(note.signed_at)}</p> : null}{invoiceState.get(note.id) ? <p className={`mt-1 text-xs ${invoiceState.get(note.id)!.attention ? "font-medium text-amber-800" : "text-slate-600"}`} data-testid="note-invoice-state" title={invoiceState.get(note.id)!.detail}>{invoiceState.get(note.id)!.invoiceId ? <Link href={invoiceHref(invoiceState.get(note.id)!.invoiceId!)} className="underline">{invoiceState.get(note.id)!.label}</Link> : invoiceState.get(note.id)!.label}</p> : null}</TableCell> : null}
                {isVisible("email") ? <TableCell data-label="Email" className="block md:table-cell">{note.emailed_at ? <Badge variant="outline">Emailed {fmtDateTime(note.emailed_at)}</Badge> : <span className="text-sm text-slate-500">Not emailed</span>}</TableCell> : null}
                <TableCell data-actions className="block md:table-cell"><div className="flex flex-wrap items-center gap-2">
                  <div className="flex shrink-0 items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => setViewing(note)}>View</Button>
                    {archive.canManage ? <ArchiveButton id={note.id ? String(note.id) : undefined} phase={phaseFor(note)} manual={note.id ? archive.manual.get(String(note.id)) : undefined} onSet={archive.setState} /> : null}
                  </div>
                  <Button variant="outline" size="sm" disabled={["despatched", "delivered", "signed"].includes(note.status)} title={["despatched", "delivered", "signed"].includes(note.status) ? "A delivery note that has been despatched can't be edited" : undefined} onClick={() => startEdit(note)}>Edit</Button>
                  <Button asChild size="sm" className="bg-brand text-brand-ink"><Link href={`/delivery-notes/${encodeURIComponent(note.id)}/print`}>Print</Link></Button>
                  {note.status === "awaiting" ? <Button size="sm" disabled={saving} className="bg-green-600 text-white hover:bg-green-700" onClick={() => void markSentOut(note)}>Mark Despatched</Button> : null}
                  {note.status === "signed" ? null : <Button variant="outline" size="sm" onClick={() => setSigningIds([note.id])}>Mark Signed</Button>}
                  {canEmail ? <Button variant="outline" size="sm" onClick={() => void openEmail(note)}>Email Customer</Button> : null}
                </div></TableCell>
              </TableRow>
            ))}</TableBody>
          </Table></CardContent></Card>
        )}
        <Dialog open={Boolean(viewing)} onOpenChange={(open) => !open && setViewing(null)}><DialogContent><DialogHeader><DialogTitle>{viewing?.ref}</DialogTitle><DialogDescription>Delivery note detail</DialogDescription></DialogHeader>{viewing ? <div className="space-y-3 text-sm"><p><strong>Customer:</strong> {viewing.customer}</p><p><strong>Job:</strong> {viewing.job || "No linked job"}</p><p><strong>Delivery date:</strong> {fmtDate(viewing.date)}</p><p><strong>Status:</strong> {viewing.status}</p>{viewing.signed_by_name ? <p><strong>Signed by:</strong> {viewing.signed_by_name} on {fmtDate(viewing.signed_at)}</p> : null}{viewing.signature_notes ? <p><strong>Signature notes:</strong> {viewing.signature_notes}</p> : null}{viewing.emailed_at ? <p><strong>Email history:</strong> Sent {fmtDateTime(viewing.emailed_at)}</p> : null}<div className="flex flex-wrap gap-2"><Button onClick={() => window.open(`/delivery-notes/${encodeURIComponent(viewing.id)}/print`, "_blank")} className="bg-brand text-brand-ink">Print</Button><Button variant="outline" onClick={() => void downloadDeliveryNotePdf(viewing)}>Download PDF</Button>{canEmail ? <Button variant="outline" onClick={() => void openEmail(viewing)}>Email Customer</Button> : null}</div>{viewing.demo ? null : <CertPack jobNo={viewing.job} canRemove={activeRole === "admin" || activeRole === "office"} />}{viewing.demo ? null : <DocumentAttachments parent={{ kind: "delivery_note", id: viewing.id }} canRemove={activeRole === "admin" || activeRole === "office" || activeRole === "workshop"} removeBlockedReason={["despatched", "delivered", "signed"].includes(viewing.status) ? "This note has gone out, so its files are kept as despatch evidence: more can be added, none removed." : null} />}{viewing.demo ? null : <DeliveryNoteInvoiceLink noteId={viewing.id} canLink={canLinkInvoice} onLinked={() => void loadNotes()} />}</div> : null}<ActivityPanel table="delivery_notes" recordId={viewing?.id} className="mt-4" /></DialogContent></Dialog>
        <Dialog open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Edit {editing?.ref}</DialogTitle><DialogDescription>Update delivery note details.</DialogDescription></DialogHeader>
            {editing ? (
              <div className="grid gap-3">
                <CustomerSelect name="edit_customer" value={editDraft.customer} onValueChange={(customer) => setEditDraft((draft) => ({ ...draft, customer }))} />
                <Input aria-label="Job reference" placeholder="Job reference" maxLength={50} value={editDraft.job} onChange={(event) => setEditDraft((draft) => ({ ...draft, job: event.target.value }))} />
                <div className="grid gap-3 md:grid-cols-3">
                  <label className="grid gap-1 text-xs text-slate-500">Delivery date<Input type="date" value={editDraft.date} onChange={(event) => setEditDraft((draft) => ({ ...draft, date: event.target.value }))} /></label>
                  <label className="grid gap-1 text-xs text-slate-500">Ship date<Input type="date" value={editDraft.shipDate} onChange={(event) => setEditDraft((draft) => ({ ...draft, shipDate: event.target.value }))} /></label>
                  <label className="grid gap-1 text-xs text-slate-500">Tax date<Input type="date" value={editDraft.taxDate} onChange={(event) => setEditDraft((draft) => ({ ...draft, taxDate: event.target.value }))} /></label>
                </div>
                <Input aria-label="Ship via" placeholder="Ship via" maxLength={100} value={editDraft.shipVia} onChange={(event) => setEditDraft((draft) => ({ ...draft, shipVia: event.target.value }))} />
                <Button disabled={saving} onClick={() => void saveEdit()} className="bg-brand text-brand-ink">{saving ? "Saving…" : "Save Changes"}</Button>
              </div>
            ) : null}
          </DialogContent>
        </Dialog>
        <Dialog open={signingIds.length > 0} onOpenChange={(open) => !open && setSigningIds([])}>
          <DialogContent>
            <DialogHeader><DialogTitle>{signingNotes.length === 1 ? `Mark ${signingNotes[0].ref} as signed` : `Mark ${signingNotes.length} delivery notes as signed`}</DialogTitle><DialogDescription>Record signature details for the delivery note{signingNotes.length === 1 ? "" : "s"}.</DialogDescription></DialogHeader>
            {signingNotes.length ? (
              <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void markSigned(signingNotes, new FormData(event.currentTarget)); }}>
                <Input name="signed_by_name" maxLength={200} placeholder="Signed by" required />
                <Input name="signed_at" type="date" defaultValue={today} required />
                <Textarea name="signature_notes" maxLength={2000} placeholder="Signature notes" />
                <Button type="submit" disabled={saving} className="bg-brand text-brand-ink">{saving ? "Saving…" : "Confirm Signed"}</Button>
              </form>
            ) : null}
          </DialogContent>
        </Dialog>
        <SendEmailDialog request={emailRequest} onClose={() => setEmailRequest(null)} />
        <Dialog open={Boolean(emailing) && canEmail} onOpenChange={(open) => !open && setEmailing(null)}>
          <DialogContent className="max-w-3xl">
            <DialogHeader><DialogTitle>Email delivery note</DialogTitle><DialogDescription>Send it from here with the PDF attached, or copy the text or open it in your email client, send it, then mark it as sent.</DialogDescription></DialogHeader>
            {emailing ? (
              company
                ? <EmailDraft note={emailing} companyName={company.name} saving={saving} onCopy={copyEmail} onSent={markEmailSent} onSendNow={sendEmailNow} />
                : <p className="text-sm text-red-700">Company details aren&apos;t set up. Ask an admin to add them in Settings.</p>
            ) : null}
          </DialogContent>
        </Dialog>
      </div>
    </RoleGate>
  );
}

/** The delivery note e-mail's values (Settings > Email templates; lib/email/templates). */
function deliveryNoteEmailVars(note: DeliveryNoteRow, companyName: string): TemplateVars {
  return { document_number: note.ref, company_name: companyName, customer_name: note.customer, job: note.job || "No linked job", delivery_date: fmtDate(note.date), status: note.status };
}

function EmailDraft({ note, companyName, saving, onCopy, onSent, onSendNow }: { note: DeliveryNoteRow; companyName: string; saving: boolean; onCopy: (note: DeliveryNoteRow, subject: string, body: string) => Promise<void>; onSent: (note: DeliveryNoteRow, subject: string, body: string) => Promise<void>; onSendNow: (note: DeliveryNoteRow, subject: string, body: string) => void }) {
  const vars = deliveryNoteEmailVars(note, companyName);
  const [subject, setSubject] = useState(() => renderTemplate("delivery_note", vars).subject);
  const [draftBody, setDraftBody] = useState(() => renderTemplate("delivery_note", vars).text);
  // A ref, not state: the template answer (which may arrive late) must see typing that happened after the effect started.
  const edited = useRef(false);
  // The company's own text (Settings > Email templates) replaces the default once loaded, unless the person has started editing.
  useEffect(() => {
    let live = true;
    void loadTemplateOverride(supabase, "delivery_note").then((override) => {
      if (!live || !override || edited.current) return;
      const email = renderTemplate("delivery_note", deliveryNoteEmailVars(note, companyName), override);
      setSubject(email.subject);
      setDraftBody(email.text);
    });
    return () => { live = false; };
    // Loaded once per opened note; `edited.current` is read when the answer arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.ref, companyName]);
  const [confirming, setConfirming] = useState(false);
  const mailto = `mailto:${encodeURIComponent(note.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(draftBody)}`;

  return (
    <div className="grid gap-3">
      <Input value={note.email} readOnly placeholder="No email address on file for this customer" />
      <Input value={subject} onChange={(event) => { edited.current = true; setSubject(event.target.value); }} />
      <Textarea className="min-h-56" value={draftBody} onChange={(event) => { edited.current = true; setDraftBody(event.target.value); }} />
      <div className="flex flex-wrap gap-2">
        <Button className="bg-brand text-brand-ink" disabled={saving} onClick={() => onSendNow(note, subject, draftBody)}>Send now</Button>
        <Button variant="outline" disabled={saving} onClick={() => void onCopy(note, subject, draftBody)}>Copy Email Body</Button>
        <Button asChild variant="outline"><a href={mailto}>Open in Email Client</a></Button>
        {confirming ? null : <Button className="bg-brand text-brand-ink" disabled={saving} onClick={() => setConfirming(true)}>Mark as Sent</Button>}
      </div>
      {confirming ? (
        <div role="group" aria-label="Confirm sent" className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <span>Only confirm once the e-mail has actually gone from your mailbox. This records it as sent to {note.email}.</span>
          <Button className="bg-brand text-brand-ink" disabled={saving} onClick={() => void onSent(note, subject, draftBody)}>{saving ? "Saving\u2026" : "I\u2019ve sent it"}</Button>
          <Button variant="outline" disabled={saving} onClick={() => setConfirming(false)}>Not yet</Button>
        </div>
      ) : null}
    </div>
  );
}
