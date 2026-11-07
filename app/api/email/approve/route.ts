import { NextResponse } from "next/server";
import { z } from "zod";
import { approveDraft } from "@/lib/email/approve-draft";
import { resendFromEnv, selectProvider, sendCompanyEmail } from "@/lib/email/send-company-email";
import { forbiddenOrigin, isErrorResponse, jsonError, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";

const schema = z.object({ draft_id: z.string().uuid(), subject: z.string().max(200), body: z.string().max(20_000), to: z.string().max(254), provider: z.literal("resend").optional() }).strict();
/** Explicit approval of saved, reviewed text; company always comes from the session. */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile(["admin", "office"]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't approve customer emails.", 403);
  const json = await readJson(request, 100_000);
  if (!json.ok) return json.response;
  const input = schema.safeParse(json.data);
  if (!input.success) return jsonError("Invalid request", 400);
  const out = await approveDraft({ org: auth.profile.organization_id, user: auth.user.id, draftId: input.data.draft_id, subject: input.data.subject, body: input.data.body, to: input.data.to, provider: input.data.provider, isAdmin: auth.profile.role === "admin" }, {
    db: auth.supabase, provider: (org) => selectProvider(org), resend: async () => resendFromEnv(process.env), send: (mail, provider) => sendCompanyEmail(mail, { db: auth.supabase, provider }),
  });
  return NextResponse.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } });
}
