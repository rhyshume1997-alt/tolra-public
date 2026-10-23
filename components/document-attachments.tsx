"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Download, Paperclip, Upload } from "lucide-react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { auditEvent } from "@/lib/audit";
import { fmtDate } from "@/lib/dates";
import {
  type AttachmentParent, type DocumentAttachment, DOCUMENT_ATTACHMENT_ACCEPT, addAttachment, attachmentProblem, attachmentUrl, attachmentsUnavailable,
  formatBytes, listAttachments, listInvoiceDeliveryNoteAttachments, removeAttachment,
} from "@/lib/document-attachments";
import { friendlyError } from "@/lib/friendly-error";

async function open(file: Pick<DocumentAttachment, "storage_path" | "file_name">) {
  try {
    window.open(await attachmentUrl(file), "_blank", "noopener");
  } catch (error) {
    toast.error(friendlyError(error, "Couldn't open the file."));
  }
}

/**
 * Photos and files on a delivery note or a purchase order (migration 067). Anyone who can open the record can add files; removing
 * one follows the record's rules (the database refuses a sent-out delivery note's files, and anyone without access).
 */
export function DocumentAttachments({ parent, canRemove, removeBlockedReason }: {
  parent: AttachmentParent;
  /** Show Remove (the database still decides). */
  canRemove: boolean;
  /** Why files can't be removed now (e.g. the note has gone out), shown instead of the Remove buttons. */
  removeBlockedReason?: string | null;
}) {
  const [files, setFiles] = useState<DocumentAttachment[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error" | "unavailable">("loading");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<DocumentAttachment | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const table = parent.kind === "delivery_note" ? "delivery_notes" : "purchase_orders";
  const what = parent.kind === "delivery_note" ? "delivery note" : "purchase order";

  // Keyed on the parent's kind and id, not the object: callers pass a fresh object each render.
  const { kind, id } = parent;
  const load = useCallback(async () => {
    setState("loading");
    try {
      setFiles(await listAttachments({ kind, id }));
      setState("ready");
    } catch (error) {
      console.error(error);
      setState(attachmentsUnavailable(error as { code?: string; message?: string }) ? "unavailable" : "error");
    }
  }, [kind, id]);
  useEffect(() => { void load(); }, [load]);

  async function onFiles(picked: FileList | null) {
    const list = Array.from(picked ?? []);
    if (input.current) input.current.value = "";
    if (!list.length) return;
    setBusy(true);
    let added = 0;
    try {
      for (const file of list) {
        const problem = attachmentProblem(file);
        if (problem) { toast.error(problem); continue; }
        try {
          const row = await addAttachment(parent, file);
          setFiles((current) => [...current, row]);
          added += 1;
          void auditEvent({ action: "UPLOAD_ATTACHMENT", entityTable: table, entityId: parent.id, metadata: { file: row.file_name, size: row.size_bytes } });
        } catch (error) {
          toast.error(friendlyError(error, `Couldn't attach ${file.name}.`));
        }
      }
      if (added) toast.success(added === 1 ? "File attached" : `${added} files attached`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(file: DocumentAttachment) {
    setRemoving(null);
    setBusy(true);
    try {
      await removeAttachment(file);
      setFiles((current) => current.filter((item) => item.id !== file.id));
      toast.success(`${file.file_name} removed`);
    } catch (error) {
      toast.error(friendlyError(error, "Couldn't remove the file."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Attachments" className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><Paperclip className="size-4" /> Photos and files</h3>
        <input ref={input} type="file" multiple aria-label="Files to attach" className="hidden" accept={DOCUMENT_ATTACHMENT_ACCEPT} onChange={(event) => void onFiles(event.target.files)} />
        <Button type="button" size="sm" variant="outline" disabled={busy || state !== "ready"} onClick={() => input.current?.click()}><Upload className="size-4" /> {busy ? "Working…" : "Attach"}</Button>
      </div>
      <p className="text-xs text-slate-500">Photos, signed copies and paperwork for this {what}. Stored privately; PDF, PNG, JPEG or WebP up to 20 MB.</p>
      {state === "loading" ? <p className="text-xs text-slate-500">Loading…</p> : null}
      {state === "unavailable" ? <p className="text-xs text-amber-800">Attachments aren&apos;t available yet: the database update that adds them hasn&apos;t been applied.</p> : null}
      {state === "error" ? <p role="alert" className="text-xs text-red-700">Couldn&apos;t load the files. <button type="button" className="underline" onClick={() => void load()}>Retry</button></p> : null}
      {state === "ready" ? (files.length ? (
        <ul className="divide-y rounded-lg border text-xs" aria-label="Attached files">
          {files.map((file) => (
            <li key={file.id} className="flex flex-wrap items-center gap-2 p-2">
              <span className="min-w-0 truncate font-medium">{file.file_name}</span>
              <span className="text-slate-500">{formatBytes(file.size_bytes)}{file.size_bytes ? ", " : ""}added {fmtDate(file.created_at)}</span>
              <span className="ml-auto flex gap-1">
                <Button type="button" size="sm" variant="ghost" onClick={() => void open(file)}><Download className="size-4" /> Open</Button>
                {canRemove && !removeBlockedReason ? <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(file)}>Remove</Button> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="text-xs text-slate-500">No files attached yet.</p>) : null}
      {state === "ready" && files.length && removeBlockedReason ? <p className="text-xs text-slate-500">{removeBlockedReason}</p> : null}
      <ConfirmDialog
        open={Boolean(removing)}
        title={`Remove ${removing?.file_name ?? "this file"}?`}
        description={`It will be taken off this ${what} and deleted. This can't be undone.`}
        confirmLabel="Remove file"
        cancelLabel="Keep file"
        destructive
        busy={busy}
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && void remove(removing)}
      />
    </section>
  );
}

/** Read-only: the files on the delivery notes that are on this invoice. Nothing shows when there are none. */
export function InvoiceDeliveryNoteFiles({ invoiceId }: { invoiceId: string }) {
  const [files, setFiles] = useState<Array<DocumentAttachment & { dn_number: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    setFiles([]);
    listInvoiceDeliveryNoteAttachments(invoiceId)
      .then((rows) => { if (!cancelled) setFiles(rows); })
      .catch((error) => console.error(error));
    return () => { cancelled = true; };
  }, [invoiceId]);
  if (!files.length) return null;
  return (
    <section aria-label="Delivery note files" className="space-y-2 rounded-lg border p-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold"><Paperclip className="size-4" /> Delivery note files</h3>
      <ul className="divide-y rounded-lg border text-xs">
        {files.map((file) => (
          <li key={file.id} className="flex flex-wrap items-center gap-2 p-2">
            <span className="font-mono">{file.dn_number}</span>
            <span className="min-w-0 truncate font-medium">{file.file_name}</span>
            <span className="text-slate-500">added {fmtDate(file.created_at)}</span>
            <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={() => void open(file)}><Download className="size-4" /> Open</Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
