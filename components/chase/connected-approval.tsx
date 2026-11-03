"use client";
import { toast } from "sonner";
import { useEffect, useState, type ReactNode } from "react";
import { ChaseApprovalCard, type ChaseEmailDraft } from "@/components/chase/approval-card";
import { approveDraft } from "@/lib/chase/ui-store";
import { supabase } from "@/lib/supabase";
import { useUser } from "@/lib/use-user";

export function ConnectedChaseApproval({ id, onDone, manualActions }: { id: string; onDone: () => void; manualActions: ReactNode }) {
  const { profile, hasAnyRole, session } = useUser();
  const org = profile?.organization_id;
  const [draft, setDraft] = useState<ChaseEmailDraft | null>(null);
  const [error, setError] = useState("");
  const canEdit = hasAnyRole(["admin", "office"]) && !session?.support && !session?.read_only;
  useEffect(() => {
    let live = true;
    async function load() {
      if (!supabase || !org) return;
      try {
        const { data: history, error } = await supabase.from("email_history").select("id, related_to_id, to_email, subject, body").eq("organization_id", org).eq("id", id).eq("status", "drafted").single();
        if (error || !history) throw error;
        const { data: invoice, error: invoiceError } = await supabase.from("invoices").select("customer, invoice_ref").eq("organization_id", org).eq("id", history.related_to_id).single();
        if (invoiceError || !invoice) throw invoiceError;
        const { data: customers, error: customerError } = await supabase.from("customers").select("id, name").eq("organization_id", org);
        if (customerError) throw customerError;
        const matches = (customers ?? []).filter((c) => c.name.trim().toLowerCase() === invoice.customer.trim().toLowerCase());
        if (matches.length !== 1) throw new Error("Check the customer record before using these controls.");
        if (live) setDraft({ id, customerId: matches[0].id, customerName: invoice.customer, invoiceNumber: invoice.invoice_ref, to: history.to_email, subject: history.subject, body: history.body });
      } catch { if (live) setError("Could not load this chase reminder. Check the customer record and reload the page."); }
    }
    void load();
    return () => { live = false; };
  }, [id, org]);
  async function checked(action: () => Promise<void>) {
    setError("");
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not save that change. Reload the page and check before trying again."); throw failure; }
  }
  return <div className="space-y-3">
    {error && <p role="alert">{error}</p>}
    {draft ? <ChaseApprovalCard key={id} draft={draft} disabled={!canEdit} onEdit={(draftId, email) => checked(async () => {
      if (!supabase || !canEdit) throw new Error("Changes are not available.");
      if (email.subject.length > 200 || email.body.length > 100000) throw new Error("Use a subject of up to 200 characters and a shorter message.");
      const { data, error } = await supabase.from("email_history").update(email).eq("organization_id", org!).eq("id", draftId).eq("status", "drafted").select("id");
      if (error || data?.length !== 1) throw new Error("The draft has changed. Reload the page before sending.");
      onDone();
    })} onApproveAndSend={(draftId) => checked(async () => {
      if (!canEdit) throw new Error("Sending is not available.");
      const result = await approveDraft(draftId);
      if (!result.recorded) toast.warning("The email was sent, but its chase record needs checking. Do not send it again.");
      onDone();
    })} onSkip={(draftId) => checked(async () => {
      if (!supabase || !canEdit) throw new Error("Changes are not available.");
      const { data, error } = await supabase.from("email_history").update({ skipped_until: new Date(Date.now() + 7 * 86400000).toISOString() }).eq("organization_id", org!).eq("id", draftId).eq("status", "drafted").select("id");
      if (error || data?.length !== 1) throw new Error("Could not skip this reminder. Reload the page.");
      onDone();
    })} onPauseCustomer={(customerId) => checked(async () => {
      if (!supabase || !canEdit) throw new Error("Changes are not available.");
      const { error } = await supabase.from("chase_pauses").upsert({ organization_id: org, customer_id: customerId, reason: "Paused from Approvals", paused_until: null }, { onConflict: "customer_id" });
      if (error) throw error;
      onDone();
    })} /> : !error && <p role="status">Loading chase reminder…</p>}
    <div className="flex flex-wrap gap-2">{manualActions}</div>
  </div>;
}
