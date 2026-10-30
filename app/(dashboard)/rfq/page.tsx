"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyList } from "@/components/empty-list";
import { rfqEmptyHint } from "@/lib/empty-hints";
import Link from "next/link";
import { toast } from "sonner";
import { FileText, HelpCircle, Inbox, MailCheck, Plus, Send, Sparkles } from "lucide-react";

import { ColumnToggle } from "@/components/column-toggle";
import { FilterBar } from "@/components/filter-bar";
import { RoleGate } from "@/components/role-gate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useCompanyProfile } from "@/lib/company";
import { ListFilterNotice, useListFilter } from "@/components/list-filter-notice";
import { fmtDate } from "@/lib/dates";
import { DEMO_MODE } from "@/lib/demo";
import { friendlyError } from "@/lib/friendly-error";
import { gbp } from "@/lib/money";
import { RFQ_DISPLAY_KEY, rfqCardFields } from "@/lib/rfq-display";
import { useColumnVisibility } from "@/lib/org-settings";
import { supabase } from "@/lib/supabase";
import { getCurrentOrganizationId } from "@/lib/supabase-business";
import { useSaving } from "@/lib/use-saving";
import { useUser } from "@/lib/use-user";
import { fetchAll, truncationNotice } from "@/lib/fetch-all";
import { logRfqClarification, rfqClarificationToast } from "@/lib/rfq-clarification";
import { type LinkedQuote, type RfqStage, linkedQuotes, matchesStatusFilter, rfqFigures, rfqSpec, rfqStage, rfqStageLabel, showsStatusBadge } from "@/lib/rfq-stage";

type RfqRow = {
  id: string;
  customer: string;
  email: string;
  phone: string;
  description: string;
  value: number;
  quantity?: number;
  material?: string;
  status: "new" | "clarification" | "ready" | "quoted";
  received: string;
  notes?: string;
};

const STAGE_META: Record<RfqStage, { label: string; badge: string }> = {
  outstanding: { label: "Outstanding", badge: "bg-amber-100 text-amber-800" },
  quoted: { label: "Quoted", badge: "rounded-md border-green-300 bg-green-100 text-green-800 dark:border-green-700 dark:bg-green-900/40 dark:text-green-200" },
  won: { label: "Won", badge: "bg-green-100 text-green-700" },
  lost: { label: "Lost", badge: "bg-red-100 text-red-700" },
};

// Sample rows are only used when DEMO_MODE is on; real tenants trust the database, including an empty result.
const sampleRfqs: RfqRow[] = [
  { id: "1", customer: "Aerospace Components Ltd", email: "procurement@aerospace.example", phone: "01698 000 0003", description: "CNC machined titanium brackets x50", value: 8400, status: "new", received: "8 May 2026", notes: "Drawing Rev 3 attached. Grade 5 Ti-6Al-4V." },
  { id: "2", customer: "Defence Manufacturing Co", email: "procurement@defencemanufacturing.example", phone: "01698 000 0004", description: "Precision milled components x200", value: 12850, status: "clarification", received: "6 May 2026", notes: "Material grade not specified." },
  { id: "3", customer: "Precision Engineering Group", email: "quotes@precision.example", phone: "01698 000 0005", description: "Stainless steel shafts x30", value: 6200, status: "ready", received: "5 May 2026", notes: "316 grade confirmed." },
];

const statusMeta = {
  new: { label: "New", badge: "bg-blue-600 text-white", icon: Inbox },
  clarification: { label: "Clarification", badge: "bg-amber-500 text-white", icon: HelpCircle },
  ready: { label: "Ready", badge: "bg-green-600 text-white", icon: Sparkles },
  quoted: { label: "Quoted", badge: "bg-slate-600 text-white", icon: FileText },
};

const TEMPLATES: Record<string, { subject: string; body: (company: string) => string }> = {
  "Material spec": {
    subject: "Material specification needed for your RFQ",
    body: (company) => `Hi,\n\nThanks for your RFQ. Before we can quote, could you please confirm the material specification (grade, condition and any certification you need)?\n\nBest regards,\n${company}`,
  },
  "Missing drawings": {
    subject: "Drawings needed for your RFQ",
    body: (company) => `Hi,\n\nThanks for your RFQ. We couldn't find drawings with your request. Could you please send the drawings (PDF or STEP, latest revision) so we can quote accurately?\n\nBest regards,\n${company}`,
  },
  "Quantity confirm": {
    subject: "Please confirm quantities for your RFQ",
    body: (company) => `Hi,\n\nThanks for your RFQ. Could you please confirm the quantities you need (and whether you would like prices for any additional quantity breaks)?\n\nBest regards,\n${company}`,
  },
};

export default function RfqPage() {
  const { profile: company } = useCompanyProfile();
  const { profile } = useUser();
  const { saving, run } = useSaving();
  const { hidden: hiddenFields } = useColumnVisibility(RFQ_DISPLAY_KEY);
  const cardFields = useMemo(() => rfqCardFields(hiddenFields), [hiddenFields]);
  const [rfqs, setRfqs] = useState<RfqRow[]>(DEMO_MODE ? sampleRfqs : []);
  const [filters, setFilters] = useState(new Set(["all"]));
  const [linked, setLinked] = useState<Map<string, LinkedQuote>>(new Map());
  const [stage, setStage] = useState<RfqStage | "all">("outstanding");
  // /rfq?filter=clarification (the dashboard's "View all"): outstanding RFQs awaiting clarification only.
  const [listFilter, clearListFilter] = useListFilter("rfq");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<RfqRow | null>(null);
  const [clarifying, setClarifying] = useState<RfqRow | null>(null);
  // The mail app was opened for this RFQ; it's only logged as sent once the person confirms it went.
  const [mailOpened, setMailOpened] = useState(false);
  const [creating, setCreating] = useState(false);
  // Microsoft 365 mail (admin only): RFQs made from an e-mail (rfq id -> stored message id), and the reply / forward dialog.
  const [inboundByRfq, setInboundByRfq] = useState<Map<string, string>>(new Map());
  const [mailLinksFailed, setMailLinksFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  // null until the server says whether Microsoft 365 mail is switched on; there is no Check inbox button until it is (hidden until built, Rhys Tue 20 Oct).
  const [mailConfigured, setMailConfigured] = useState<boolean | null>(null);
  const [mailing, setMailing] = useState<{ rfq: RfqRow; mode: "reply" | "forward" } | null>(null);
  const [mailTo, setMailTo] = useState("");
  const [mailComment, setMailComment] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const signOffName = company?.name ?? "";
  const openClarify = useCallback((rfq: RfqRow) => {
    setViewing(null);
    setSubject("Clarification needed for RFQ");
    setBody(`Hi,\n\nThanks for the RFQ. Before quoting, could you please confirm the missing details below?\n\nBest regards,\n${signOffName}`);
    setMailOpened(false);
    setClarifying(rfq);
  }, [signOffName]);

  useEffect(() => {
    if (profile?.role !== "admin") return;
    let live = true;
    fetch("/api/mail/status")
      .then((res) => (res.ok ? res.json() : { configured: false }))
      .then((result: { configured?: boolean }) => { if (live) setMailConfigured(result.configured === true); })
      .catch(() => { if (live) setMailConfigured(false); });
    return () => { live = false; };
  }, [profile?.role]);

  const loadRfqs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (!supabase) {
        if (!DEMO_MODE) throw new Error("Supabase is not configured.");
        setRfqs(sampleRfqs);
        return;
      }
      // Every row, page by page (lib/fetch-all): the API returns at most 1,000 per request.
        const { rows: data, truncated } = await fetchAll((from, to) => supabase!.from("rfqs").select("*").order("created_at", { ascending: false }).order("id").range(from, to));
        const error = null;
        if (truncated) toast.warning(truncationNotice(data.length));
      if (error) throw error;
      // The quote made for each RFQ (lib/rfq-stage linkedQuotes: accepted, then sent, then draft, then rejected; newest among equals).
      // If this read fails nothing can be said about which RFQs are quoted, so it is an error (with Retry), never "outstanding".
      const { data: quoteRows, error: quoteError } = await supabase.from("quotes").select("id, quote_ref, status, rfq_id, created_at").not("rfq_id", "is", null).order("created_at", { ascending: true });
      if (quoteError) throw quoteError;
      // RFQs that came from an e-mail. No rows is fine; a failed read is unknown, so say so instead of quietly hiding Reply / Forward.
      const { data: inboundRows, error: inboundError } = await supabase.from("inbound_emails").select("id, rfq_id").not("rfq_id", "is", null);
      setMailLinksFailed(Boolean(inboundError));
      setInboundByRfq(new Map((inboundRows ?? []).map((row) => [String(row.rfq_id), String(row.id)])));
      setLinked(linkedQuotes(quoteRows ?? []));
      setRfqs((data as Array<Record<string, unknown>>).map((rfq) => ({
        id: String(rfq.id),
        customer: String(rfq.customer || ""),
        email: String(rfq.email || ""),
        phone: String(rfq.phone || ""),
        description: String(rfq.description || ""),
        value: Number(rfq.estimated_value ?? 0),
        quantity: Number(rfq.quantity ?? 0),
        material: String(rfq.material || ""),
        status: String(rfq.status || "new") as RfqRow["status"],
        received: fmtDate(String(rfq.created_at)),
        notes: rfq.notes ? String(rfq.notes) : "",
      })));
    } catch (err) {
      setError(friendlyError(err, "Couldn't load RFQs."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadRfqs(); }, [loadRfqs]);

  const stageOf = useCallback((rfq: RfqRow) => rfqStage(rfq, linked.get(rfq.id)), [linked]);
  const visible = useMemo(() => rfqs.filter((rfq) => (listFilter ? stageOf(rfq) === "outstanding" && rfq.status === "clarification" : (stage === "all" || stageOf(rfq) === stage) && matchesStatusFilter(filters, stageOf(rfq), rfq.status))), [filters, listFilter, rfqs, stage, stageOf]);
  // The intake counts are of RFQs still outstanding: a quoted RFQ keeps its old intake status, which nothing updates. The same
  // figures as the dashboard (lib/rfq-stage rfqFigures).
  const figures = useMemo(() => rfqFigures(rfqs, linked), [rfqs, linked]);
  const count = (status: "new" | "clarification" | "ready") => (loading || error ? "\u2014" : String(figures[status]));

  async function saveRfq(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    await run(async () => {
      try {
        if (!supabase) throw new Error("Supabase is not configured.");
        const organizationId = await getCurrentOrganizationId();
        const { error } = await supabase.from("rfqs").insert({
          organization_id: organizationId,
          customer: String(form.get("customer") || ""),
          email: String(form.get("email") || ""),
          phone: String(form.get("phone") || ""),
          description: String(form.get("description") || ""),
          quantity: Number(form.get("quantity") || 0),
          material: String(form.get("material") || ""),
          estimated_value: Number(form.get("value") || 0),
          status: String(form.get("status") || "new"),
          notes: String(form.get("notes") || ""),
        });
        if (error) throw error;
        toast.success("RFQ saved");
        formEl.reset();
        setCreating(false);
        await loadRfqs();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn't save the RFQ. Try again."));
      }
    });
  }

  /** Reads new inbox messages into RFQs (Microsoft 365, admin only). Doesn't change the mailbox. */
  async function checkInbox() {
    setChecking(true);
    try {
      const res = await fetch("/api/mail/poll", { method: "POST" });
      const result = (await res.json().catch(() => ({}))) as { error?: string; read?: number; inserted?: number; duplicates?: number };
      if (!res.ok) throw new Error(result.error || "Couldn't check the inbox.");
      toast.success(`Inbox checked: ${result.read ?? 0} read, ${result.inserted ?? 0} new, ${result.duplicates ?? 0} already seen`);
      if (result.inserted) await loadRfqs();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't check the inbox.");
    } finally {
      setChecking(false);
    }
  }

  function openMail(rfq: RfqRow, mode: "reply" | "forward") {
    setViewing(null);
    setMailTo("");
    setMailComment("");
    setMailing({ rfq, mode });
  }

  /** Replies to, or forwards, the e-mail this RFQ was made from, from the connected mailbox. */
  async function sendMailAction() {
    if (!mailing) return;
    const inboundEmailId = inboundByRfq.get(mailing.rfq.id);
    await run(async () => {
      try {
        const res = await fetch(`/api/mail/${mailing.mode}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(mailing.mode === "reply" ? { inboundEmailId, comment: mailComment } : { inboundEmailId, to: mailTo, comment: mailComment }),
        });
        const result = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(result.error || "Couldn't send the email.");
        toast.success(mailing.mode === "reply" ? "Reply sent" : "Forwarded");
        setMailing(null);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't send the email.");
      }
    });
  }

  /** Opens the user's email app with the text (we can't send email from here). Nothing is logged yet. */
  function openClarification() {
    if (!clarifying) return;
    if (!clarifying.email) {
      toast.error("This RFQ has no email address. Add one before sending.");
      return;
    }
    window.location.href = `mailto:${encodeURIComponent(clarifying.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    setMailOpened(true);
  }

  /** The person confirmed they sent it: log it in email history as sent manually. */
  async function confirmClarificationSent() {
    if (!clarifying) return;
    const rfq = clarifying;
    await run(async () => {
      try {
        if (!supabase) throw new Error("Supabase is not configured.");
        // One call (migration 110): the e-mail is logged and an outstanding RFQ moves to Awaiting clarification together, or neither.
        const { status, moved } = await logRfqClarification(supabase, rfq.id, subject, body);
        setClarifying(null);
        if (moved) setRfqs((current) => current.map((row) => (row.id === rfq.id ? { ...row, status: status as RfqRow["status"] } : row)));
        toast.success(rfqClarificationToast(moved));
      } catch (err) {
        toast.error(friendlyError(err, "Couldn't log the email. Try again."));
      }
    });
  }

  return (
    <RoleGate allowed={["admin", "office"]}>
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="page-title">RFQ Control Centre</h1>
          <p className="mt-2 text-sm text-slate-500">RFQ means request for quote: a customer asking us for a price.</p>
        </div>
        <div className="flex flex-wrap gap-2">
        <ColumnToggle tableKey={RFQ_DISPLAY_KEY} />
        {profile?.role === "admin" && mailConfigured ? <Button variant="outline" disabled={checking} onClick={() => void checkInbox()}><MailCheck className="size-4" /> {checking ? "Checking\u2026" : "Check inbox"}</Button> : null}
        <Dialog open={creating} onOpenChange={setCreating}>
          <DialogTrigger asChild><Button className="bg-brand text-brand-ink hover:bg-brand-hover"><Plus className="size-4" /> New RFQ</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Create New RFQ</DialogTitle><DialogDescription>Capture customer requirements and status.</DialogDescription></DialogHeader>
            <form onSubmit={saveRfq} className="grid gap-3">
              <Input name="customer" placeholder="Customer" required />
              <div className="grid gap-3 md:grid-cols-2"><Input name="email" type="email" inputMode="email" autoComplete="email" placeholder="Email" /><Input name="phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="Phone" /></div>
              <Textarea name="description" placeholder="Description" required />
              <div className="grid gap-3 md:grid-cols-3"><Input name="quantity" type="number" inputMode="numeric" min="0" step="1" placeholder="Quantity" /><select name="material" className="h-9 rounded-lg border px-3 text-sm"><option value="">Choose material</option><option>Titanium Grade 5</option><option>Aluminium 6082</option><option>Stainless Steel 304</option><option>Stainless Steel 316</option><option>Mild Steel</option><option>Brass C360</option><option>Other</option></select><Input name="value" type="number" inputMode="decimal" min="0" step="0.01" placeholder="Value" /></div>
              <select name="status" className="h-9 rounded-lg border px-3 text-sm"><option value="new">New</option><option value="clarification">Clarification</option><option value="ready">Ready</option></select>
              <Textarea name="notes" placeholder="Notes" />
              <Button disabled={saving} className="bg-brand text-brand-ink hover:bg-brand-hover">{saving ? "Saving..." : "Save RFQ"}</Button>
            </form>
          </DialogContent>
        </Dialog>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {[["New RFQs", count("new"), "new"], ["Awaiting Clarification", count("clarification"), "clarification"], ["Ready to Quote", count("ready"), "ready"]].map(([label, value, filter]) => (
          <Card key={label} className="cursor-pointer transition hover:bg-slate-50" onClick={() => setFilters(new Set([filter]))}><CardContent className="p-5"><p className="text-sm text-slate-500">{label}</p><p className="mt-2 text-3xl font-bold text-slate-950">{value}</p></CardContent></Card>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Show">
        <span className="text-[0.8125rem] font-semibold text-slate-600">Show</span>
        {(["outstanding", "quoted", "won", "lost", "all"] as const).map((value) => (
          <Button key={value} size="sm" variant={stage === value ? "default" : "outline"} aria-pressed={stage === value} className={stage === value ? "bg-brand text-brand-ink" : ""} onClick={() => setStage(value)}>
            {value === "all" ? "All" : `${STAGE_META[value].label} (${figures[value]})`}
          </Button>
        ))}
      </div>
      {listFilter ? <ListFilterNotice label="RFQs awaiting clarification" onClear={clearListFilter} /> : null}
      <FilterBar activeValues={[...filters]} options={[{ label: "All", value: "all" }, { label: "New", value: "new" }, { label: "Clarification", value: "clarification" }, { label: "Ready", value: "ready" }]} onChange={setFilters} />
      {mailLinksFailed && !error ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Couldn&apos;t check which RFQs came from an email, so Reply and Forward may be missing. <button onClick={() => void loadRfqs()} className="font-semibold underline">Retry</button></div> : null}
      {error ? <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error} <button onClick={() => void loadRfqs()} className="font-semibold underline">Retry</button></div> : null}

      {loading ? <div className="grid gap-4"><Skeleton className="h-32" /><Skeleton className="h-32" /></div> : (
        <div className="grid gap-4">
          {!visible.length && !error ? <EmptyList title={rfqs.length ? "No RFQs match this filter" : "No RFQs yet"} hint={rfqs.length ? "Try a different filter." : rfqEmptyHint()} hintTestId={rfqs.length ? undefined : "empty-hint"} /> : null}
          {visible.map((rfq) => {
            // Once a quote exists the intake status (New, Ready...) no longer applies: show the Quoted icon, not the old status.
            const meta = statusMeta[showsStatusBadge(stageOf(rfq)) ? rfq.status : "quoted"];
            const Icon = meta.icon;
            return (
              <Card key={rfq.id} className="shadow-sm">
                <CardContent className="flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex gap-4">
                    <div className="flex size-11 items-center justify-center rounded-lg bg-slate-50"><Icon className="size-5 text-brand-accent" /></div>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        {cardFields.filter((field) => field.group === "title").map((field) => {
                          if (field.key === "customer") return <h3 key={field.key} data-rfq-field="customer" className="font-semibold text-slate-950">{rfq.customer}</h3>;
                          if (field.key === "status") return showsStatusBadge(stageOf(rfq)) ? <Badge key={field.key} data-rfq-field="status" className={meta.badge}>{meta.label}</Badge> : null;
                          return <Badge key={field.key} data-rfq-field="stage" className={STAGE_META[stageOf(rfq)].badge}>{rfqStageLabel(stageOf(rfq), linked.get(rfq.id))}{linked.get(rfq.id) ? <> {"\u00b7"} <strong className="font-bold">{linked.get(rfq.id)!.ref}</strong></> : null}</Badge>;
                        })}
                      </div>
                      {cardFields.filter((field) => field.group === "body").map((field) => <p key={field.key} data-rfq-field={field.key} className="mt-2 text-sm text-slate-600">{rfq.description}</p>)}
                      {cardFields.some((field) => field.group === "meta" && field.key !== "actions") ? (
                        <p className="mt-2 text-xs text-slate-500">
                          {cardFields.filter((field) => field.group === "meta" && field.key !== "actions").map((field, index) => (
                            <span key={field.key} data-rfq-field={field.key}>{index ? " \u00b7 " : ""}{field.key === "value" ? <>Value: <strong>{gbp(rfq.value, 0)}</strong></> : <>Received: {rfq.received}</>}</span>
                          ))}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div data-rfq-field="actions" className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => setViewing(rfq)}>View</Button>
                    {profile?.role === "admin" && inboundByRfq.has(rfq.id) ? <><Button variant="outline" onClick={() => openMail(rfq, "reply")}>Reply</Button><Button variant="outline" onClick={() => openMail(rfq, "forward")}>Forward</Button></> : null}
                    {rfq.status === "clarification" && stageOf(rfq) === "outstanding" ? <Button className="bg-amber-500 text-white hover:bg-amber-600" onClick={() => openClarify(rfq)}>Clarify</Button> : linked.get(rfq.id) ? <Button asChild variant="outline"><Link href={linked.get(rfq.id)!.id ? `/quotes?quote=${encodeURIComponent(linked.get(rfq.id)!.id!)}` : "/quotes"}>Open {linked.get(rfq.id)!.ref}</Link></Button> : <Button asChild className="bg-brand text-brand-ink hover:bg-brand-hover"><Link href={`/quotes?rfq=${encodeURIComponent(rfq.id)}`}>Quote</Link></Button>}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={Boolean(viewing)} onOpenChange={(open) => !open && setViewing(null)}>
        <DialogContent><DialogHeader><DialogTitle>{viewing?.customer}</DialogTitle><DialogDescription>Full RFQ information</DialogDescription></DialogHeader>{viewing ? <div className="space-y-3 text-sm"><p>{viewing.description}</p>{rfqSpec(viewing.quantity, viewing.material).quantity ? <p><strong>Quantity:</strong> {rfqSpec(viewing.quantity, viewing.material).quantity}</p> : null}{rfqSpec(viewing.quantity, viewing.material).material ? <p className="break-words"><strong>Material:</strong> {rfqSpec(viewing.quantity, viewing.material).material}</p> : null}<p><strong>Value:</strong> {gbp(viewing.value, 0)}</p><p><strong>Email:</strong> {viewing.email}</p><p><strong>Notes:</strong> {viewing.notes || "-"}</p><div className="flex gap-2"><Button asChild><Link href={`/quotes?rfq=${encodeURIComponent(viewing.id)}`}>Create Quote</Link></Button><Button variant="outline" onClick={() => openClarify(viewing)}>Clarify</Button></div></div> : null}</DialogContent>
      </Dialog>
      <Dialog open={Boolean(mailing)} onOpenChange={(open) => !open && setMailing(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{mailing?.mode === "forward" ? "Forward email" : "Reply to email"}</DialogTitle><DialogDescription>{mailing?.rfq.customer}{mailing?.mode === "reply" && mailing.rfq.email ? ` (${mailing.rfq.email})` : ""}. Sent from the connected Microsoft 365 mailbox.</DialogDescription></DialogHeader>
          <div className="grid gap-3">
            {mailing?.mode === "forward" ? <Input type="email" value={mailTo} onChange={(event) => setMailTo(event.target.value)} placeholder="Forward to" aria-label="Forward to" /> : null}
            <Textarea className="min-h-32" value={mailComment} onChange={(event) => setMailComment(event.target.value)} placeholder={mailing?.mode === "forward" ? "Note (optional)" : "Message"} aria-label="Message" />
            <Button disabled={saving || (mailing?.mode === "reply" ? !mailComment.trim() : !mailTo.trim())} onClick={() => void sendMailAction()}><Send className="size-4" /> {saving ? "Sending\u2026" : mailing?.mode === "forward" ? "Forward" : "Send reply"}</Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(clarifying)} onOpenChange={(open) => !open && setClarifying(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Clarification Email</DialogTitle><DialogDescription>{clarifying?.customer}{clarifying?.email ? ` (${clarifying.email})` : ""}</DialogDescription></DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-2 md:grid-cols-3">
              {Object.entries(TEMPLATES).map(([name, template]) => (
                <Button key={name} variant="outline" onClick={() => { setSubject(template.subject); setBody(template.body(signOffName)); }}>{name}</Button>
              ))}
            </div>
            <Input value={subject} onChange={(event) => setSubject(event.target.value)} aria-label="Subject" />
            <Textarea className="min-h-44" value={body} onChange={(event) => setBody(event.target.value)} aria-label="Message" />
            <p className="text-xs text-slate-500">This opens your email app with the message ready to send. Once you&apos;ve sent it, log it here.</p>
            <div className="flex flex-wrap gap-2">
              <Button variant={mailOpened ? "outline" : "default"} disabled={saving} onClick={openClarification}><Send className="size-4" /> Open in email app</Button>
              {mailOpened ? <Button disabled={saving} onClick={() => void confirmClarificationSent()}>{saving ? "Saving\u2026" : "I\u2019ve sent it"}</Button> : null}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
    </RoleGate>
  );
}
