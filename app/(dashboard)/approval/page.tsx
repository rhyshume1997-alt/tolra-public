"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckCircle, Clipboard, Info, Mail } from "lucide-react";

import { ColumnToggle } from "@/components/column-toggle";
import { Badge } from "@/components/ui/badge";
import { RoleGate } from "@/components/role-gate";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { auditEvent } from "@/lib/audit";
import { fmtDate, fmtDateTime, nowIso } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import { awaitingApproval } from "@/lib/approval-queue";
import { useColumnVisibility } from "@/lib/org-settings";
import { supabase } from "@/lib/supabase";
import { useSaving } from "@/lib/use-saving";
import { cn } from "@/lib/utils";
import { PRODUCT } from "@/lib/product";

type ApprovalTone = "red" | "amber" | "blue";

type ApprovalItem = {
  id: string;
  badge: string;
  tone: ApprovalTone;
  customer: string;
  detail: string;
  drafted: string;
  to: string;
  subject: string;
  body: string;
};

type SentItem = { id: string; customer: string; when: string; status: string };

const toneStyles: Record<ApprovalTone, { border: string; badge: string; button: string }> = {
  red: { border: "border-l-red-600", badge: "bg-red-600 text-white", button: "bg-red-600 text-white hover:bg-red-700" },
  amber: { border: "border-l-amber-500", badge: "bg-amber-500 text-white", button: "bg-amber-500 text-white hover:bg-amber-600" },
  blue: { border: "border-l-blue-600", badge: "bg-blue-600 text-white", button: "bg-blue-600 text-white hover:bg-blue-700" },
};

const TYPE_LABEL: Record<string, string> = {
  invoice: "INVOICE", quote: "QUOTE", sales_order: "SALES ORDER", purchase_order: "PURCHASE ORDER", delivery_note: "DELIVERY NOTE", rfq: "RFQ", job: "JOB", general: "GENERAL",
};

const SKIP_DAYS = 7;

function updateSharedApprovalCount(count: number) {
  window.dispatchEvent(new CustomEvent("approval-count-change", { detail: count }));
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toApproval(row: any): ApprovalItem {
  const type = String(row.related_to_type || "general");
  return {
    id: String(row.id),
    badge: TYPE_LABEL[type] ?? "DRAFT",
    tone: type === "invoice" ? "amber" : "blue",
    customer: row.to_name || row.to_email || "Recipient",
    detail: row.subject || "",
    drafted: row.drafted_at ? fmtDate(row.drafted_at) : "",
    to: row.to_email || "",
    subject: row.subject || "",
    body: row.body || "",
  };
}

export default function ApprovalPage() {
  const { saving, run } = useSaving();
  const { isVisible } = useColumnVisibility("approvals");
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [recent, setRecent] = useState<SentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingItem, setEditingItem] = useState<ApprovalItem | null>(null);
  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");
  const [previewItem, setPreviewItem] = useState<ApprovalItem | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (!supabase) throw new Error("Supabase is not configured.");
      const [drafts, sent] = await Promise.all([
        awaitingApproval(supabase.from("email_history").select("id, to_email, to_name, subject, body, related_to_type, drafted_at, skipped_until"))
          .order("drafted_at", { ascending: false }),
        supabase
          .from("email_history")
          .select("id, to_email, to_name, status, sent_at, drafted_at")
          .in("status", ["sent_manually", "sent_via_system"])
          .order("sent_at", { ascending: false, nullsFirst: false })
          .limit(5),
      ]);
      if (drafts.error) throw drafts.error;
      if (sent.error) throw sent.error;
      const items = (drafts.data ?? []).map(toApproval);
      setApprovals(items);
      updateSharedApprovalCount(items.length);
      setRecent((sent.data ?? []).map((row: any) => ({
        id: String(row.id),
        customer: row.to_name || row.to_email || "Recipient",
        when: fmtDateTime(row.sent_at || row.drafted_at),
        status: row.status === "sent_via_system" ? `Sent by ${PRODUCT.name}` : "Sent manually",
      })));
    } catch (err) {
      setError(friendlyError(err, "Couldn't load the approval queue."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function removeLocal(id: string) {
    setApprovals((current) => {
      const next = current.filter((item) => item.id !== id);
      updateSharedApprovalCount(next.length);
      return next;
    });
  }

  async function copyToClipboard(item: ApprovalItem) {
    try {
      await navigator.clipboard.writeText(item.body);
      toast.success(`Draft copied for ${item.customer}`);
    } catch (err) {
      console.error(err);
      toast.error("Couldn't copy. Select the text in Preview Full and copy it manually.");
    }
  }

  function markSentManually(item: ApprovalItem) {
    if (!window.confirm(`Mark the email to ${item.customer} as sent? Only do this once you've actually sent it.`)) return;
    void run(async () => {
      try {
        if (!supabase) throw new Error("Supabase is not configured.");
        const { error: updateError } = await supabase.from("email_history").update({ status: "sent_manually", sent_at: nowIso() }).eq("id", item.id).eq("status", "drafted");
        if (updateError) throw updateError;
        removeLocal(item.id);
        toast.success(`Marked as sent manually to ${item.customer}`);
        void load();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn't update the email. Try again."));
      }
    });
  }

  function openEmailClient(item: ApprovalItem) {
    window.location.href = `mailto:${encodeURIComponent(item.to)}?subject=${encodeURIComponent(item.subject)}&body=${encodeURIComponent(item.body)}`;
  }

  function skipApproval(item: ApprovalItem) {
    if (!window.confirm(`Skip this reminder? It won't show again for ${SKIP_DAYS} days.`)) return;
    void run(async () => {
      try {
        if (!supabase) throw new Error("Supabase is not configured.");
        const until = new Date(Date.now() + SKIP_DAYS * 86_400_000).toISOString();
        const { error: updateError } = await supabase.from("email_history").update({ skipped_until: until }).eq("id", item.id);
        if (updateError) throw updateError;
        removeLocal(item.id);
        toast.success(`Reminder skipped for ${item.customer}`);
      } catch (err) {
        toast.error(friendlyError(err, "Couldn't skip this reminder. Try again."));
      }
    });
  }

  function openEdit(item: ApprovalItem) {
    setEditSubject(item.subject);
    setEditBody(item.body);
    setEditingItem(item);
  }

  function saveEdit() {
    if (!editingItem) return;
    const item = editingItem;
    void run(async () => {
      try {
        if (!supabase) throw new Error("Supabase is not configured.");
        const { error: updateError } = await supabase.from("email_history").update({ subject: editSubject, body: editBody }).eq("id", item.id).eq("status", "drafted");
        if (updateError) throw updateError;
        setApprovals((current) => current.map((entry) => (entry.id === item.id ? { ...entry, subject: editSubject, body: editBody, detail: editSubject } : entry)));
        void auditEvent({ action: "UPDATE", entityTable: "email_history", entityId: item.id, metadata: { fields: ["subject", "body"] } });
        setEditingItem(null);
        toast.success("Draft updated");
      } catch (err) {
        toast.error(friendlyError(err, "Couldn't save the draft. Try again."));
      }
    });
  }

  return (
    <RoleGate allowed={["admin", "office"]}>
    <div className="space-y-8">
      <section className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="page-title">Approval Queue</h1>
          <p className="mt-2 text-sm text-slate-500">Emails Tolra has drafted wait here for you to check before they go to customers.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2"><ColumnToggle tableKey="approvals" /></div>
        {/* No Settings button: it linked to the admin-only general /settings page, which has no e-mail or approval settings (sweep item 8). */}
      </section>

      <Card className="border-blue-200 bg-blue-50 shadow-sm">
        <CardContent className="flex gap-3 p-5">
          <Info className="mt-0.5 size-5 shrink-0 text-blue-600" />
          <p className="text-sm font-medium text-blue-950">
            Email sending isn&apos;t set up yet, so emails are saved as drafts. Copy a draft or open it in your email client, send it yourself, then choose Mark as Sent Manually.
            {loading || error ? "" : ` ${approvals.length} draft${approvals.length === 1 ? "" : "s"} waiting.`}
          </p>
        </CardContent>
      </Card>

      {error ? (
        <Card><CardContent className="flex flex-wrap items-center justify-between gap-3 p-5"><p className="text-sm text-red-700">{error}</p><Button variant="outline" onClick={() => void load()}>Retry</Button></CardContent></Card>
      ) : null}

      <section className="space-y-4">
        {loading ? (
          <Skeleton className="h-40" />
        ) : !error && approvals.length === 0 ? (
          <Card className="border-green-200 shadow-sm">
            <CardContent className="flex flex-col items-center justify-center px-6 py-14 text-center">
              <div className="flex size-14 items-center justify-center rounded-full bg-green-50">
                <CheckCircle className="size-8 text-green-600" />
              </div>
              <h3 className="mt-4 text-lg font-semibold text-slate-950">All Caught Up</h3>
              <p className="mt-2 text-sm text-slate-500">No drafted emails are waiting for approval.</p>
            </CardContent>
          </Card>
        ) : (
          approvals.map((item) => {
            const styles = toneStyles[item.tone];
            return (
              <Card key={item.id} className={cn("border-l-4 shadow-sm", styles.border)}>
                <CardHeader className="gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-3">
                    {isVisible("type") ? <Badge className={styles.badge}>{item.badge}</Badge> : null}
                    <div>
                      <CardTitle className="text-xl">{item.customer}</CardTitle>
                      <p className="mt-1 text-sm text-slate-500">{item.detail}</p>
                    </div>
                  </div>
                  {isVisible("drafted") ? <div className="text-sm text-slate-500">Drafted: {item.drafted}</div> : null}
                </CardHeader>

                <CardContent className="space-y-4">
                  <div className="grid gap-3 rounded-lg bg-slate-50 p-4 text-sm md:grid-cols-[auto_1fr]">
                    <span className="field-label">To:</span>
                    <span className="text-slate-900">{item.to}</span>
                    {isVisible("subject") ? (
                      <>
                        <span className="field-label">Subject:</span>
                        <span className="text-slate-900">&quot;{item.subject}&quot;</span>
                      </>
                    ) : null}
                  </div>

                  {isVisible("preview") ? <div className="relative max-h-24 overflow-hidden rounded-lg border border-slate-200 bg-white p-4 text-sm leading-6 text-slate-600">
                    {item.body.split("\n").slice(0, 5).map((line, index) => (
                      <p key={`${item.id}-preview-${index}`}>{line || " "}</p>
                    ))}
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-white to-white/0" />
                  </div> : null}

                  <div className="flex flex-col gap-2 md:flex-row md:items-center">
                    <Button className={styles.button} onClick={() => void copyToClipboard(item)}>
                      <Clipboard className="size-4" />
                      Copy to Clipboard
                    </Button>
                    <Button variant="outline" disabled={saving} onClick={() => markSentManually(item)}>Mark as Sent Manually</Button>
                    <Button variant="outline" onClick={() => openEmailClient(item)}>
                      <Mail className="size-4" />
                      Open in Email Client
                    </Button>
                    <Button variant="outline" onClick={() => openEdit(item)}>Edit</Button>
                    <Button variant="outline" onClick={() => setPreviewItem(item)}>Preview Full</Button>
                    <Button variant="ghost" disabled={saving} className="text-slate-500 hover:text-slate-900 md:ml-auto" onClick={() => skipApproval(item)}>Skip</Button>
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold text-slate-950">Recently Sent</h2>
        <Card className="shadow-sm">
          <CardContent className="divide-y divide-slate-100 p-0">
            {recent.length ? recent.map((item) => (
              <div key={item.id} className="flex gap-3 p-4">
                <CheckCircle className="mt-0.5 size-5 shrink-0 text-green-600" />
                <div className="flex-1">
                  <p className="font-semibold text-slate-950">{item.customer}</p>
                  <p className="mt-1 text-sm text-slate-500">{item.when} · {item.status}</p>
                </div>
              </div>
            )) : <p className="p-4 text-sm text-slate-500">{loading ? "Loading..." : "Nothing has been sent yet."}</p>}
          </CardContent>
        </Card>
      </section>

      <Dialog open={Boolean(editingItem)} onOpenChange={(open) => !open && setEditingItem(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Email</DialogTitle>
            <DialogDescription>Adjust the subject or message before sending.</DialogDescription>
          </DialogHeader>
          {editingItem ? (
            <div className="space-y-4">
              <label className="block text-sm font-medium text-slate-700">
                Subject
                <input className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand" value={editSubject} onChange={(event) => setEditSubject(event.target.value)} />
              </label>
              <label className="block text-sm font-medium text-slate-700">
                Body
                <textarea className="mt-1 min-h-56 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand" value={editBody} onChange={(event) => setEditBody(event.target.value)} />
              </label>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setEditingItem(null)}>Cancel</Button>
                <Button className="bg-brand text-brand-ink hover:bg-brand-hover" disabled={saving} onClick={saveEdit}>{saving ? "Saving..." : "Save Draft"}</Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(previewItem)} onOpenChange={(open) => !open && setPreviewItem(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Full Email Preview</DialogTitle>
            <DialogDescription>{previewItem?.customer}</DialogDescription>
          </DialogHeader>
          {previewItem ? (
            <div className="space-y-4">
              <div className="rounded-lg bg-slate-50 p-4 text-sm">
                <p><span className="field-label">To:</span> {previewItem.to}</p>
                <p className="mt-2"><span className="field-label">Subject:</span> {previewItem.subject}</p>
              </div>
              <div className="whitespace-pre-wrap rounded-lg border border-slate-200 p-4 text-sm leading-6 text-slate-700">{previewItem.body}</div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
    </RoleGate>
  );
}
