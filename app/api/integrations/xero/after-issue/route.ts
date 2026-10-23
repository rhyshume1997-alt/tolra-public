import { NextResponse } from "next/server";
import { z } from "zod";

import { sendQueued, xeroReady } from "@/lib/integrations/server";
import { AUTOMATIC_SEND_ROLES } from "@/lib/integrations/xero/policy";
import { forbiddenOrigin, isErrorResponse, jsonError, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const maxDuration = 60;

const schema = z.object({ doc_type: z.enum(["invoice", "credit_note"]), doc_id: z.string().uuid() });

/**
 * The automatic send right after an invoice or credit note is issued, or an invoice voided (lib/integrations/nudge.ts): best effort, for
 * whoever issued it (admin or office). It sends only THAT document, and only its first attempt (the database's claim refuses anything else:
 * no retry, no resend, no other document; those are an admin's, /api/integrations/xero/send). Only the caller's own company; counts only.
 * Issuing never waits for or fails because of it; nothing is sent unless connected and every account and VAT rate used is mapped.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile([...AUTOMATIC_SEND_ROLES]);
  if (isErrorResponse(auth)) return auth;
  // Support access (the platform owner inside a company) holds an admin membership but never changes or reads through this company's Xero:
  // refused before any Xero or database call, as on the Admin > Users routes. The database's connect functions exclude support too.
  if (auth.session?.support) return jsonError("Support access can't change Xero settings.", 403);
  const json = await readJson(request, 1024);
  if (!json.ok) return json.response;
  const parsed = schema.safeParse(json.data);
  if (!parsed.success) return jsonError("Invalid request", 400);
  const ready = xeroReady();
  const service = createSupabaseAdminClient();
  if (!ready || !service) return NextResponse.json({ skipped: "not_configured" });
  try {
    const summary = await sendQueued(service, auth.profile.organization_id, ready,
      { maxDocuments: 2, budgetMs: 20_000, only: { docType: parsed.data.doc_type, docId: parsed.data.doc_id } });
    return NextResponse.json(summary);
  } catch (err) {
    console.error("[integrations] after-issue send failed:", (err as { code?: string }).code ?? (err instanceof Error ? err.name : "error"));
    return NextResponse.json({ error: "The send to Xero stopped; an admin can send it from Admin > Integrations." }, { status: 500 });
  }
}
