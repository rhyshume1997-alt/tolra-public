import { NextResponse } from "next/server";
import { Resend } from "resend";

import { checkResend, resendConfigStatus } from "@/lib/email/resend-status";
import { CONNECT_ROLES } from "@/lib/integrations/xero/policy";
import { forbiddenOrigin, isErrorResponse, requireProfile, sameOrigin } from "@/lib/server/auth";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store" };

/** Admin > Integrations > Resend: the server's settings as a status (never the key). Admin only, two-step as every admin route. */
export async function GET() {
  const auth = await requireProfile([...CONNECT_ROLES]);
  if (isErrorResponse(auth)) return auth;
  return NextResponse.json(resendConfigStatus(), { headers });
}

/** Test: one read-only call to Resend (list domains) to confirm the key and the sender's verified domain. Sends no e-mail. */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile([...CONNECT_ROLES]);
  if (isErrorResponse(auth)) return auth;
  const key = process.env.RESEND_API_KEY?.trim();
  const status = key ? await checkResend(process.env, new Resend(key)) : resendConfigStatus();
  return NextResponse.json(status, { headers });
}
