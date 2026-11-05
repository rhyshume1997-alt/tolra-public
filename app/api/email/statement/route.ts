import { NextResponse } from "next/server";
import { z } from "zod";
import { customerStatement } from "@/lib/email/customer-statement";
import { sendCompanyEmail } from "@/lib/email/send-company-email";
import { forbiddenOrigin, isErrorResponse, jsonError, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";

const schema = z.object({ customer_id: z.string().uuid(), idempotency_key: z.string().uuid() });
/** A customer statement is always a draft, even when providers/keys are present. */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile(["admin", "office"]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't prepare customer emails.", 403);
  const json = await readJson(request, 8192);
  if (!json.ok) return json.response;
  const input = schema.safeParse(json.data);
  if (!input.success) return jsonError("Invalid request", 400);
  try {
    const statement = await customerStatement(auth.supabase, auth.profile.organization_id, input.data.customer_id);
    const answer = await sendCompanyEmail({ organizationId: auth.profile.organization_id, userId: auth.user.id, kind: "statement", to: [statement.to], subject: statement.subject, text: statement.text, recordType: "general", recordId: statement.recordId, idempotencyKey: input.data.idempotency_key, draftOnly: true, requireLedger: true }, { db: auth.supabase });
    if (!answer.ok) return jsonError(answer.error, 502);
    return NextResponse.json({ status: "drafted", history_id: answer.historyId }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) { return jsonError(err instanceof Error ? err.message : "Could not prepare the statement. Nothing was sent.", 400); }
}
