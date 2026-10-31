import { NextResponse } from "next/server";
import { z } from "zod";

import { batchDeps } from "@/lib/integrations/xero/batch-deps";
import { BATCH_CHUNK, parseRange } from "@/lib/integrations/xero/batch";
import { BeforeConnectionError, loadConnection, previewBatch, runBatchChunk } from "@/lib/integrations/xero/batch-server";
import { xeroReady } from "@/lib/integrations/server";
import { MANUAL_SEND_ROLES } from "@/lib/integrations/xero/policy";
import { forbiddenOrigin, isErrorResponse, jsonError, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const dynamic = "force-dynamic";
// A call sends at most BATCH_CHUNK documents and starts no new one after 35 s; one already started may need a few Xero calls.
export const maxDuration = 60;

const item = z.object({ doc_type: z.enum(["invoice", "credit_note"]), doc_id: z.string().uuid() });
// include_before_connection: the admin ticked "Include documents issued before Xero was connected". Without it a range (or a document with no
// send row) dated before the connection day is refused: it may already be in Xero, and a first attempt does not look first.
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("info") }),
  z.object({ action: z.literal("preview"), from: z.string(), to: z.string(), mode: z.enum(["unsent", "failed_only"]), include_before_connection: z.boolean().optional() }),
  z.object({ action: z.literal("send"), mode: z.enum(["unsent", "failed_only"]), items: z.array(item).min(1).max(BATCH_CHUNK), include_before_connection: z.boolean().optional() }),
]);

/**
 * Admin > Integrations > Send a date range to Xero. ADMIN ONLY with the second step of sign-in, like every manual send (Rhys, Wed 21 Oct);
 * a support session is refused before any database or Xero call.
 *   preview: the issued invoices and credit notes between two dates (inclusive) that the chosen mode would send, with counts of the rest.
 *   send:    a few of them (the page sends the list in small calls), each through the engine with its per-document idempotency. What is
 *            sent is decided again here from the database, never from the page's list: a document already sent, being sent, to check in
 *            Xero, voided, not issued, imported or from another company is left alone and reported as such.
 * Only the caller's own company.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile([...MANUAL_SEND_ROLES]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't change Xero settings.", 403);
  const json = await readJson(request, 8 * 1024);
  if (!json.ok) return json.response;
  const parsed = schema.safeParse(json.data);
  if (!parsed.success) return jsonError("Invalid request", 400);
  const body = parsed.data;
  const ready = await xeroReady();
  const service = createSupabaseAdminClient();
  if (!ready || !service) return jsonError("Xero is not set up on this server yet.", 503);
  const org = auth.profile.organization_id;
  try {
    if (body.action === "info") return NextResponse.json(await loadConnection(service, org));
    if (body.action === "preview") {
      const range = parseRange(body.from, body.to);
      if (!range.ok) return jsonError(range.error, 400);
      return NextResponse.json(await previewBatch({ docsClient: auth.supabase, service, org, range: range.range, mode: body.mode, includeBefore: body.include_before_connection === true }));
    }
    const connection = await loadConnection(service, org);
    if (!connection.connected) return jsonError("Connect this company to Xero first.", 409);
    const outcome = await runBatchChunk(batchDeps({ user: auth.supabase, service, org, ready }),
      body.items.map((i) => ({ docType: i.doc_type, id: i.doc_id })), body.mode,
      { connectedOn: connection.connectedOn, includeBefore: body.include_before_connection === true });
    return NextResponse.json(outcome);
  } catch (err) {
    if (err instanceof BeforeConnectionError) return jsonError(err.message, 400);
    console.error("[integrations] batch failed:", (err as { code?: string }).code ?? (err instanceof Error ? err.name : "error"));
    return jsonError("The batch stopped. Nothing is sent twice: preview again to see what is left.", 500);
  }
}
