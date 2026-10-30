import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { XeroConfig } from "@/lib/integrations/xero/oauth";
import { sendQueued } from "@/lib/integrations/server";
import { type ChunkDeps, SEND_COLUMNS, toBatchSend } from "@/lib/integrations/xero/batch-server";
import { CREDIT_COLUMNS, INVOICE_COLUMNS, type BatchDoc, type BatchDocType, creditDocument, invoiceDocument } from "@/lib/integrations/xero/batch";


/**
 * The real dependencies of one batch call: the signed-in admin's client reads the documents (their company only, by RLS) and queues a
 * failed row again (integration_retry_send: the database checks admin and two-step sign-in); the service role reads and queues the send
 * rows of the admin's own company (every query carries the organisation) and runs the engine (lib/integrations/server.ts sendQueued).
 */
export function batchDeps(opts: { user: SupabaseClient; service: SupabaseClient; org: string; ready: { config: XeroConfig; key: Buffer } }): ChunkDeps {
  const { user, service, org, ready } = opts;
  return {
    async loadDoc(docType: BatchDocType, id: string): Promise<BatchDoc | null> {
      if (docType === "invoice") {
        const { data, error } = await user.from("invoices").select(INVOICE_COLUMNS).eq("organization_id", org).eq("id", id).maybeSingle();
        if (error) throw new Error(error.message);
        return data ? invoiceDocument(data as Parameters<typeof invoiceDocument>[0]) : null;
      }
      const { data, error } = await user.from("credit_notes").select(CREDIT_COLUMNS).eq("organization_id", org).eq("id", id).maybeSingle();
      if (error) throw new Error(error.message);
      return data ? creditDocument(data as Parameters<typeof creditDocument>[0]) : null;
    },
    async loadSend(docType, id) {
      const { data, error } = await service.from("integration_sends").select(SEND_COLUMNS).eq("organization_id", org).eq("provider", "xero")
        .eq("doc_type", docType).eq("doc_id", id).eq("action", "create").maybeSingle();
      if (error) throw new Error(error.message);
      return data ? toBatchSend(data as Parameters<typeof toBatchSend>[0]) : null;
    },
    async isImported(id) {
      const { data, error } = await service.from("import_record_keys").select("record_id").eq("organization_id", org).eq("record_id", id).limit(1);
      if (error) throw new Error(error.message);
      return (data ?? []).length > 0;
    },
    async enqueue(doc) {
      // The same row 084's issue trigger adds, and nothing else: the unique key (company, provider, type, id, action) means a second
      // insert (a double click, two tabs) changes nothing. Only while the company is connected.
      const { data: conn, error: connError } = await service.from("integration_connections").select("status").eq("organization_id", org).eq("provider", "xero").maybeSingle();
      if (connError) throw new Error(connError.message);
      if ((conn as { status?: string } | null)?.status !== "connected") throw new Error("not connected");
      const { error } = await service.from("integration_sends").upsert(
        { organization_id: org, provider: "xero", doc_type: doc.docType, doc_id: doc.id, doc_ref: doc.ref ? doc.ref.slice(0, 100) : null, action: "create" },
        { onConflict: "organization_id,provider,doc_type,doc_id,action", ignoreDuplicates: true });
      if (error) throw new Error(error.message);
    },
    async retry(sendId) {
      const { error } = await user.rpc("integration_retry_send", { p_send: sendId });
      if (error) throw new Error(error.message);
    },
    run: (only) => sendQueued(service, org, ready, { maxDocuments: 1, budgetMs: 15_000, ...(only ? { only } : {}) }),
    now: () => Date.now(),
  };
}
