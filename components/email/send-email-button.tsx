"use client";

import { useEffect, useRef, useState } from "react";
import { Mail } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { type TemplateKey, type TemplateVars, renderTemplate } from "@/lib/email/templates/defaults";
import { loadTemplateOverride } from "@/lib/email/templates/store";
import { supabase } from "@/lib/supabase";

export type SendEmailKind = "quote" | "invoice" | "purchase_order" | "delivery_note";

/** What the dialog sends: the document, who to, the template and its values, and (optionally) how to build the PDF. */
export type SendEmailRequest = {
  kind: SendEmailKind;
  recordId: string;
  templateKey: TemplateKey;
  to: string | null | undefined;
  vars: TemplateVars;
  /** Text the person already wrote (the delivery note's e-mail editor): used instead of the template. */
  initial?: { subject: string; body: string };
  /** Builds the document's PDF (the same element the Download button renders); attached when given. */
  pdf?: { filename: string; build: () => Promise<Blob> };
  /** The old way, kept as a secondary link: opens the person's own mail app (and, on the pages that did it, downloads the PDF). */
  onOpenMailApp?: (subject: string, body: string) => void;
  /** Called once the e-mail was actually sent (not for a draft). */
  onSent?: () => void;
};

export type SendOutcome = { kind: "sent" } | { kind: "drafted" } | { kind: "error"; message: string };

/** The answer of POST /api/email/send in words for the person. */
export function sendOutcomeFrom(status: number, payload: { status?: string; error?: string }): SendOutcome {
  if (status >= 200 && status < 300 && payload.status === "sent") return { kind: "sent" };
  if (status >= 200 && status < 300 && payload.status === "drafted") return { kind: "drafted" };
  if (status === 401) return { kind: "error", message: "Your session has ended. Sign in again." };
  return { kind: "error", message: payload.error && payload.error !== "Forbidden" && payload.error !== "Invalid request" ? payload.error : status === 403 ? "You can't send this e-mail." : "Couldn't send the e-mail. Try again." };
}

export const OUTCOME_TEXT = { sent: "Sent", drafted: "Saved as draft for Approvals" } as const;

/** Comma, semicolon or space separated addresses. */
export const splitAddresses = (value: string) => value.split(/[\s,;]+/).map((part) => part.trim()).filter(Boolean);

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/**
 * The one-click send dialog: To (prefilled from the customer or supplier on file), subject and text from the company's template
 * (Settings > Email templates), the PDF attached, Send. The server sends from the company's Microsoft 365 mailbox when connected, else
 * Resend, else saves a draft for Approvals; the dialog says which ("Sent" / "Saved as draft for Approvals") or shows the error.
 * "Open in my mail app" keeps the old way.
 */
export function SendEmailDialog({ request, onClose }: { request: SendEmailRequest | null; onClose: () => void }) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [attach, setAttach] = useState(true);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<SendOutcome | null>(null);
  const edited = useRef(false);
  const key = useRef(newKey());

  useEffect(() => {
    if (!request) return;
    edited.current = false;
    key.current = newKey();
    setOutcome(null);
    setAttach(Boolean(request.pdf));
    setTo(request.to ?? "");
    if (request.initial) {
      setSubject(request.initial.subject.replace(/[\r\n]+/g, " "));
      setBody(request.initial.body);
      return;
    }
    const first = renderTemplate(request.templateKey, request.vars);
    setSubject(first.subject);
    setBody(first.text);
    let live = true;
    void loadTemplateOverride(supabase, request.templateKey).then((override) => {
      if (!live || !override || edited.current) return;
      const email = renderTemplate(request.templateKey, request.vars, override);
      setSubject(email.subject);
      setBody(email.text);
    });
    return () => { live = false; };
  }, [request]);

  async function send() {
    if (!request) return;
    const recipients = splitAddresses(to);
    if (!recipients.length) return setOutcome({ kind: "error", message: "Enter an e-mail address to send to." });
    setSending(true);
    setOutcome(null);
    try {
      let attachment: { filename: string; content_base64: string } | undefined;
      if (attach && request.pdf) {
        const blob = await request.pdf.build();
        if (blob.size > 3 * 1024 * 1024) throw new Error("The PDF is larger than 3 MB, too large to attach. Use Open in my mail app instead.");
        attachment = { filename: request.pdf.filename, content_base64: await toBase64(blob) };
      }
      const response = await fetch("/api/email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: request.kind, record_id: request.recordId, to: recipients, subject, text: body, attachment, idempotency_key: key.current }),
      });
      const payload = (await response.json().catch(() => ({}))) as { status?: string; error?: string };
      const result = sendOutcomeFrom(response.status, payload);
      setOutcome(result);
      // A definite answer ends this e-mail: a new click is a new e-mail. An unclear one keeps the key, so a retry can't send it twice.
      if (result.kind !== "error") key.current = newKey();
      if (result.kind === "sent") request.onSent?.();
    } catch (err) {
      setOutcome({ kind: "error", message: err instanceof Error && err.message ? err.message : "Couldn't send the e-mail. Try again." });
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={Boolean(request)} onOpenChange={(open) => { if (!open && !sending) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Send by e-mail</DialogTitle>
          <DialogDescription>Sent from your company&apos;s e-mail. If sending isn&apos;t set up yet, it is saved as a draft in Approvals.</DialogDescription>
        </DialogHeader>
        {request ? (
          <SendEmailForm to={to} subject={subject} body={body} attach={attach} canAttach={Boolean(request.pdf)} pdfName={request.pdf?.filename}
            sending={sending} outcome={outcome}
            onTo={(value) => { edited.current = true; setTo(value); }}
            onSubject={(value) => { edited.current = true; setSubject(value.replace(/[\r\n]+/g, " ")); }}
            onBody={(value) => { edited.current = true; setBody(value); }}
            onAttach={setAttach} onSend={() => void send()} onClose={onClose}
            onOpenMailApp={request.onOpenMailApp ? () => request.onOpenMailApp?.(subject, body) : undefined}
            mailto={`mailto:${encodeURIComponent(splitAddresses(to).join(","))}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** The dialog's fields and buttons (no state of its own, so a test can render it). */
export function SendEmailForm(props: {
  to: string; subject: string; body: string; attach: boolean; canAttach: boolean; pdfName?: string; sending: boolean; outcome: SendOutcome | null;
  onTo: (value: string) => void; onSubject: (value: string) => void; onBody: (value: string) => void; onAttach: (value: boolean) => void;
  onSend: () => void; onClose: () => void; onOpenMailApp?: () => void; mailto: string;
}) {
  const done = props.outcome?.kind === "sent" || props.outcome?.kind === "drafted";
  return (
    <div className="grid gap-3">
      <label className="grid gap-1 text-xs font-semibold text-slate-700">To
        <Input type="text" inputMode="email" value={props.to} placeholder="No e-mail address on file: type one" disabled={props.sending || done} onChange={(event) => props.onTo(event.target.value)} />
      </label>
      <label className="grid gap-1 text-xs font-semibold text-slate-700">Subject
        <Input value={props.subject} maxLength={200} disabled={props.sending || done} onChange={(event) => props.onSubject(event.target.value)} />
      </label>
      <label className="grid gap-1 text-xs font-semibold text-slate-700">Message
        <Textarea className="min-h-48" value={props.body} disabled={props.sending || done} onChange={(event) => props.onBody(event.target.value)} />
      </label>
      {props.canAttach ? (
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={props.attach} disabled={props.sending || done} onChange={(event) => props.onAttach(event.target.checked)} />
          Attach {props.pdfName ?? "the PDF"}
        </label>
      ) : null}
      {props.outcome ? (
        <p role={props.outcome.kind === "error" ? "alert" : "status"} className={`rounded-md border p-2 text-sm ${props.outcome.kind === "error" ? "border-red-200 bg-red-50 text-red-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>
          {props.outcome.kind === "error" ? props.outcome.message : OUTCOME_TEXT[props.outcome.kind]}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {done
          ? <Button className="bg-brand text-brand-ink" onClick={props.onClose}>Close</Button>
          : <Button className="bg-brand text-brand-ink" disabled={props.sending} onClick={props.onSend}><Mail className="mr-1 size-4" />{props.sending ? "Sending..." : "Send"}</Button>}
        {props.onOpenMailApp
          ? <Button variant="link" className="px-1 text-sm" disabled={props.sending} onClick={props.onOpenMailApp}>Open in my mail app</Button>
          : <a className="px-1 text-sm text-brand-accent underline" href={props.mailto}>Open in my mail app</a>}
      </div>
    </div>
  );
}

/** A button that opens the send dialog for one document (for screens with no send flow of their own). */
export function SendEmailButton({ request, label = "Email", disabled, variant = "outline" }: { request: () => SendEmailRequest | null; label?: string; disabled?: boolean; variant?: "outline" | "default" }) {
  const [open, setOpen] = useState<SendEmailRequest | null>(null);
  return (
    <>
      <Button variant={variant} disabled={disabled} onClick={() => setOpen(request())}><Mail className="mr-1 size-4" />{label}</Button>
      <SendEmailDialog request={open} onClose={() => setOpen(null)} />
    </>
  );
}
