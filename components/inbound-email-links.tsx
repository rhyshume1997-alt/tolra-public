"use client";

/**
 * Inbox e-mails linked to a quote (the customer's PO) or a purchase order (a supplier's document), migration 125. Suggest only: the
 * inbox check saves candidates; a person picks one and clicks Link (link_inbound_email, p_how 'manual'), which for a quote also puts the
 * PO on it through 123's set_quote_customer_po when 123 is applied and the quote has no PO yet. Without 125 everything here hides itself.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Link2, Mail } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fmtDate } from "@/lib/dates";
import { NEEDS_DATABASE_UPDATE, missingDbObject } from "@/lib/db-features";
import { friendlyError } from "@/lib/friendly-error";
import { extractPoNumbers, normalisePo } from "@/lib/po-capture";
import { supabase } from "@/lib/supabase";

export type LinkSuggestion = { kind: "quote" | "purchase_order"; id: string; ref: string; po: string | null };
export type LinkedEmail = {
  id: string;
  rfqId: string | null;
  fromAddress: string;
  fromName: string;
  subject: string;
  receivedAt: string;
  bodyText: string;
  linkStatus: "suggested" | "manual" | "auto" | null;
  linkedQuoteId: string | null;
  linkedPurchaseOrderId: string | null;
  linkedPoNumber: string | null;
  suggestions: LinkSuggestion[];
};

export const LINKED_EMAIL_COLUMNS = "id, rfq_id, from_address, from_name, subject, received_at, body_text, link_status, linked_quote_id, linked_purchase_order_id, linked_po_number, link_suggestions";

export function toLinkedEmail(row: Record<string, unknown>): LinkedEmail {
  const list = Array.isArray(row.link_suggestions) ? (row.link_suggestions as Array<Record<string, unknown>>) : [];
  return {
    id: String(row.id),
    rfqId: row.rfq_id ? String(row.rfq_id) : null,
    fromAddress: String(row.from_address ?? ""),
    fromName: String(row.from_name ?? ""),
    subject: String(row.subject ?? ""),
    receivedAt: String(row.received_at ?? ""),
    bodyText: String(row.body_text ?? ""),
    linkStatus: (row.link_status as LinkedEmail["linkStatus"]) ?? null,
    linkedQuoteId: row.linked_quote_id ? String(row.linked_quote_id) : null,
    linkedPurchaseOrderId: row.linked_purchase_order_id ? String(row.linked_purchase_order_id) : null,
    linkedPoNumber: row.linked_po_number ? String(row.linked_po_number) : null,
    suggestions: list
      .filter((s) => (s.kind === "quote" || s.kind === "purchase_order") && s.id)
      .map((s) => ({ kind: s.kind as LinkSuggestion["kind"], id: String(s.id), ref: String(s.ref ?? ""), po: s.po ? String(s.po) : null })),
  };
}

/** The e-mails (125) that have a link or suggestions; for a quote, those linked to it or suggested for it. null = 125 isn't applied (or
 * the read failed): show nothing. */
export async function loadLinkedEmails(filter?: { quoteId: string }): Promise<LinkedEmail[] | null> {
  if (!supabase) return null;
  const select = () => supabase!.from("inbound_emails").select(LINKED_EMAIL_COLUMNS);
  const read = (narrow: (q: ReturnType<typeof select>) => ReturnType<typeof select>) => narrow(select()).order("received_at", { ascending: false }).limit(200);
  const results = filter
    ? await Promise.all([read((q) => q.eq("linked_quote_id", filter.quoteId)), read((q) => q.eq("link_status", "suggested").contains("link_suggestions", [{ id: filter.quoteId }]))])
    : [await read((q) => q.not("link_status", "is", null))];
  const failed = results.find((r) => r.error)?.error;
  if (failed) {
    if (!missingDbObject(failed)) console.error("[inbound-email-links] read failed", failed.code);
    return null;
  }
  const seen = new Set<string>();
  return results.flatMap((r) => r.data ?? []).map((row) => toLinkedEmail(row as Record<string, unknown>)).filter((e) => !seen.has(e.id) && Boolean(seen.add(e.id)))
    .filter((e) => !filter || e.linkedQuoteId === filter.quoteId || (e.linkStatus === "suggested" && e.suggestions.some((s) => s.kind === "quote" && s.id === filter.quoteId)));
}

/** The sentence around the PO in the e-mail, found again from its stored text. */
export function matchedSnippet(email: Pick<LinkedEmail, "subject" | "bodyText" | "fromAddress">, po: string | null): string | null {
  if (!po) return null;
  const want = normalisePo(po);
  return extractPoNumbers({ fromAddress: email.fromAddress, subject: email.subject, bodyText: email.bodyText }).find((p) => p.normalised === want)?.snippet ?? null;
}

const linkedMessage = (ref: string, po: string | null, state: string | undefined) => {
  if (state === "written") return `Linked to ${ref}. PO ${po} added to the quote.`;
  if (state === "kept_existing") return `Linked to ${ref}. The quote keeps the PO it already has.`;
  if (state === "no_quote_po_yet") return `Linked to ${ref}. The quote's PO field needs a database update, so add PO ${po} there later.`;
  return `Linked to ${ref}.`;
};

/** The one-click Link. Returns true when it went through. */
export async function linkEmail(email: LinkedEmail, s: LinkSuggestion): Promise<boolean> {
  try {
    if (!supabase) throw new Error("Supabase is not configured.");
    const { data, error } = await supabase.rpc("link_inbound_email", { p_email: email.id, p_kind: s.kind, p_target: s.id, p_po: s.po, p_how: "manual" });
    if (error) {
      if (missingDbObject(error)) toast.error(NEEDS_DATABASE_UPDATE);
      else toast.error(friendlyError(error, "Couldn't link the email. Try again."));
      return false;
    }
    toast.success(s.kind === "quote" ? linkedMessage(s.ref, s.po, (data as { po_state?: string } | null)?.po_state) : `Linked to ${s.ref}.`);
    return true;
  } catch (err) {
    toast.error(friendlyError(err, "Couldn't link the email. Try again."));
    return false;
  }
}

function EmailFacts({ email }: { email: LinkedEmail }) {
  return (
    <p className="text-xs text-slate-600">
      <span className="font-medium text-slate-800">{email.fromName || email.fromAddress}</span>
      {email.fromName && email.fromAddress ? <> &lt;{email.fromAddress}&gt;</> : null}
      {email.receivedAt ? <> {"·"} {fmtDate(email.receivedAt)}</> : null}
      {email.subject ? <> {"·"} <span className="italic">{email.subject}</span></> : null}
    </p>
  );
}

/**
 * What one e-mail is linked to, or what it may be: on an RFQ card and on the quote. With several suggestions John picks one; each shows
 * the PO and the sentence it was found in. onlyFor limits the suggestions to one quote (the quote screen).
 */
export function EmailLinkPanel({ email, onLinked, onlyFor, onViewEmail, canLink = true }: { email: LinkedEmail; onLinked?: () => void; onlyFor?: string; onViewEmail?: (id: string) => void; canLink?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [ref, setRef] = useState<string | null>(null);
  const linkedId = email.linkStatus === "manual" || email.linkStatus === "auto" ? (email.linkedQuoteId ?? email.linkedPurchaseOrderId) : null;
  const isQuote = Boolean(email.linkedQuoteId);
  const viewEmail = (className: string) => (onViewEmail
    ? <button type="button" className={className} onClick={() => onViewEmail(email.id)}>View email</button>
    : <Link className={className} href={`/rfq?email=${encodeURIComponent(email.id)}`}>View email</Link>);

  useEffect(() => {
    if (!linkedId || !supabase) return;
    const known = email.suggestions.find((s) => s.id === linkedId)?.ref;
    if (known) { setRef(known); return; }
    let live = true;
    const query = isQuote ? supabase.from("quotes").select("quote_ref").eq("id", linkedId).maybeSingle() : supabase.from("purchase_orders").select("po_ref, po_number").eq("id", linkedId).maybeSingle();
    void query.then(({ data }) => {
      const row = data as Record<string, unknown> | null;
      if (live && row) setRef(String(row.quote_ref ?? row.po_ref ?? row.po_number ?? ""));
    });
    return () => { live = false; };
  }, [linkedId, isQuote, email.suggestions]);

  if (linkedId) {
    return (
      <div data-testid="email-link" className="flex flex-wrap items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900">
        <Link2 className="size-4" />
        <span className="font-semibold">{isQuote ? "Customer PO email linked" : "Supplier email linked"}</span>
        {ref ? <Badge variant="outline" className="font-mono">{ref}</Badge> : null}
        {email.linkedPoNumber ? <span>PO {email.linkedPoNumber}</span> : null}
        {viewEmail("font-semibold underline")}
        {isQuote && !onlyFor ? <Link className="font-semibold underline" href={`/quotes?quote=${encodeURIComponent(linkedId)}`}>Open {ref ?? "quote"}</Link> : null}
      </div>
    );
  }

  const suggestions = email.suggestions.filter((s) => !onlyFor || (s.kind === "quote" && s.id === onlyFor));
  if (email.linkStatus !== "suggested" || !suggestions.length) return null;
  return (
    <div data-testid="email-link-suggestions" className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
      <p className="font-semibold">{suggestions.length > 1 ? "This email may be about one of these. Pick the right one:" : suggestions[0].kind === "quote" ? "This email may be the customer's PO:" : "This email may be about our purchase order:"}</p>
      <EmailFacts email={email} />
      <ul className="space-y-2">
        {suggestions.map((s) => {
          const snippet = matchedSnippet(email, s.po);
          return (
            <li key={`${s.kind}:${s.id}:${s.po ?? ""}`} className="flex flex-wrap items-center gap-2">
              {canLink ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={async () => { setBusy(true); const ok = await linkEmail(email, s); setBusy(false); if (ok) onLinked?.(); }}>
                  Link to {s.ref}
                </Button>
              ) : <Badge variant="outline" className="font-mono">{s.ref}</Badge>}
              {s.po ? <span className="font-medium">PO {s.po}</span> : null}
              {snippet ? <span className="min-w-0 text-xs text-slate-600">&ldquo;{snippet}&rdquo;</span> : null}
            </li>
          );
        })}
      </ul>
      {viewEmail("text-xs font-semibold underline")}
    </div>
  );
}

/** The stored e-mail itself (from, date, subject, text), opened by /rfq?email=<id>. */
export function EmailViewer({ emailId, onClose }: { emailId: string | null; onClose: () => void }) {
  const [email, setEmail] = useState<LinkedEmail | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setEmail(null);
    setFailed(false);
    if (!emailId || !supabase) return;
    let live = true;
    void supabase.from("inbound_emails").select("id, rfq_id, from_address, from_name, subject, received_at, body_text").eq("id", emailId).maybeSingle().then(({ data, error }) => {
      if (!live) return;
      if (error || !data) setFailed(true);
      else setEmail(toLinkedEmail(data as Record<string, unknown>));
    });
    return () => { live = false; };
  }, [emailId]);
  return (
    <Dialog open={Boolean(emailId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Mail className="size-4" /> {email?.subject || "Email"}</DialogTitle>
          <DialogDescription>{email ? `${email.fromName || email.fromAddress}${email.fromName && email.fromAddress ? ` <${email.fromAddress}>` : ""} · ${fmtDate(email.receivedAt)}` : failed ? "This email couldn't be found." : "Loading…"}</DialogDescription>
        </DialogHeader>
        {email ? <pre data-testid="email-body" className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-slate-50 p-3 font-sans text-sm text-slate-800">{email.bodyText || "(no text)"}</pre> : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * On the quote: the customer PO e-mail linked to it, e-mails that may be its PO (Link), and, when the quote has no customer PO yet and
 * a linked e-mail has one, "Use PO 4471" (123's set_quote_customer_po; hidden without 123). Manual PO entry on the quote is untouched.
 */
export function QuoteLinkedEmails({ quoteId, quoteRef }: { quoteId: string | null | undefined; quoteRef: string }) {
  const [emails, setEmails] = useState<LinkedEmail[]>([]);
  const [quotePo, setQuotePo] = useState<string | null | undefined>(undefined); // undefined: 123 not applied (no column) or unknown
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!quoteId || !supabase) return;
    setEmails((await loadLinkedEmails({ quoteId })) ?? []);
    const { data, error } = await supabase.from("quotes").select("customer_po").eq("id", quoteId).maybeSingle();
    setQuotePo(error || !data ? undefined : ((data as { customer_po?: string | null }).customer_po ?? null));
  }, [quoteId]);
  useEffect(() => { void load(); }, [load]);

  if (!quoteId || !emails.length) return null;
  const linkedPo = emails.find((e) => e.linkedQuoteId === quoteId && e.linkedPoNumber)?.linkedPoNumber ?? null;

  async function applyPo(po: string) {
    setBusy(true);
    try {
      const { error } = await supabase!.rpc("set_quote_customer_po", { p_quote: quoteId, p_customer_po: po });
      if (error) toast.error(missingDbObject(error) ? NEEDS_DATABASE_UPDATE : friendlyError(error, "Couldn't save the PO. Try again."));
      else { toast.success(`PO ${po} added to ${quoteRef}.`); await load(); }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="quote-linked-emails" className="space-y-2">
      {emails.map((email) => <EmailLinkPanel key={email.id} email={email} onlyFor={quoteId} onLinked={() => void load()} />)}
      {linkedPo && quotePo === null ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void applyPo(linkedPo)}>Use PO {linkedPo}</Button>
      ) : null}
    </div>
  );
}
