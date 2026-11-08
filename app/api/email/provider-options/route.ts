import { NextResponse } from "next/server";

import { resendFromEnv } from "@/lib/email/send-company-email";
import { isErrorResponse, requireProfile } from "@/lib/server/auth";

/** Whether the explicit "send via Resend instead" choice may be offered: an admin of the company, and Resend's keys configured. Booleans only. */
export async function GET() {
  const auth = await requireProfile(["admin", "office"]);
  if (isErrorResponse(auth)) return auth;
  const admin = auth.profile.role === "admin" && !auth.session?.support;
  return NextResponse.json({ admin, resend: admin && resendFromEnv(process.env) !== null }, { headers: { "Cache-Control": "no-store" } });
}
