import { NextResponse } from "next/server";
import { z } from "zod";

import { resend } from "@/lib/resend";
import { forbiddenOrigin, isErrorResponse, jsonError, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";
import { PRODUCT } from "@/lib/product";
import { sendWithOutcome } from "@/lib/send-outcome";

const sendJobSchema = z.object({
  job_id: z.string().uuid(),
  recipient_email: z.string().trim().toLowerCase().email().max(254),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10000),
  // The same key for retries of one e-mail (double click, network retry); older clients may leave it out.
  idempotency_key: z.string().regex(/^[A-Za-z0-9-]{8,100}$/).optional(),
});

/** EMAIL_RECIPIENT_DOMAINS: comma separated; "example.com" allows the domain, "a@example.com" allows one address. */
function onAllowlist(email: string) {
  const entries = (process.env.EMAIL_RECIPIENT_DOMAINS || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const domain = email.split("@")[1] ?? "";
  return entries.some((entry) => (entry.includes("@") ? entry === email : entry.replace(/^@/, "") === domain));
}

const clean = (value: unknown) => (typeof value === "string" ? value.trim().toLowerCase() : "");

export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();

  const auth = await requireProfile(["admin", "office"]);
  if (isErrorResponse(auth)) return auth;
  const { supabase, profile } = auth;

  const json = await readJson(request, 32 * 1024);
  if (!json.ok) return json.response;
  const parsed = sendJobSchema.safeParse(json.data);
  if (!parsed.success) return jsonError("Invalid request", 400);
  const { job_id, recipient_email, subject, body } = parsed.data;
  const key = parsed.data.idempotency_key ?? crypto.randomUUID();

  const { data: job } = await supabase.from("jobs").select("*").eq("id", job_id).maybeSingle();
  if (!job || job.organization_id !== profile.organization_id) return jsonError("Job not found", 404);

  // Recipient must be this job's customer, one of this organisation's workshop addresses, or allowlisted.
  let allowed = onAllowlist(recipient_email) || clean(job.customer_email) === recipient_email;
  if (!allowed) {
    // An internal job (migration 042) may have no customer: then only a workshop address or the allowlist is accepted.
    const customerName = String(job.customer ?? job.customer_name ?? "").trim();
    const customerLookup = job.customer_id
      ? supabase.from("customers").select("email").eq("organization_id", profile.organization_id).eq("id", job.customer_id).limit(1)
      : supabase.from("customers").select("email").eq("organization_id", profile.organization_id).eq("name", customerName || "\u0000no customer").limit(1);
    const { data: customers } = await customerLookup;
    allowed = (customers ?? []).some((row) => clean(row.email) === recipient_email);
  }
  if (!allowed) {
    const { data: workshops } = await supabase
      .from("user_profiles")
      .select("workshop_email")
      .eq("organization_id", profile.organization_id)
      .not("workshop_email", "is", null);
    allowed = (workshops ?? []).some((row) => clean(row.workshop_email) === recipient_email);
  }
  if (!allowed) return jsonError("Recipient not allowed for this job", 403);

  const from = resend ? process.env.EMAIL_FROM || (process.env.NODE_ENV === "production" ? "" : `${PRODUCT.name} <notifications@resend.dev>`) : "";
  if (resend && !from) return jsonError("Email sender not configured", 503);

  // Limits are checked and the attempt recorded in one database transaction (migration 025), before any provider
  // call, in a ledger the visible history can't reset.
  const { data: reservation, error: reserveError } = await supabase.rpc("reserve_job_email", {
    p_job: job_id,
    p_recipient: recipient_email,
    p_subject: subject,
    p_body: body,
    p_key: key,
    p_mode: resend ? "sending" : "drafted",
  });
  if (reserveError) {
    if (reserveError.code === "PT429") return NextResponse.json({ status: "failed", error: reserveError.message }, { status: 429 });
    if (reserveError.code === "PT409") return jsonError(reserveError.message, 409);
    console.error("[send-job] reservation failed", reserveError.code);
    return jsonError("Could not send email", 500);
  }
  const { history_id: historyId, replay, status } = reservation as { history_id: string; replay: boolean; status: string };
  if (replay) {
    // Already handled under this key: report it, never send twice.
    if (status === "sent_via_system") return NextResponse.json({ status: "sent" });
    if (status === "drafted") return NextResponse.json({ status: "drafted" });
    if (status === "unknown") return NextResponse.json({ status: "unknown", error: UNKNOWN_MESSAGE }, { status: 409 });
    return NextResponse.json({ status: "failed", error: "This email is already being sent." }, { status: 409 });
  }
  if (!resend) return NextResponse.json({ status: "drafted" });
  const provider = resend;

  // The outcome is recorded in the ledger, not only the history (migration 033). A definite refusal (the provider's own 4xx
  // answer) may be tried again; a network error, timeout or server error is 'unknown': it may have gone, so there is no
  // automatic second attempt and an admin settles it (Email history).
  const { outcome, detail } = await sendWithOutcome(() => provider.emails.send({ from, to: recipient_email, subject, text: body }, { idempotencyKey: `job-email/${key}` }));
  if (outcome !== "accepted") console.error("[send-job] send", outcome, detail);

  const { error: completeError } = await supabase.rpc("complete_job_email", { p_history: historyId, p_outcome: outcome });
  // If this write is lost the ledger stays 'sending' and becomes 'unknown' after ten minutes: never a silent retry.
  if (completeError) console.error("[send-job] outcome not recorded", completeError.code);

  if (outcome === "failed") return NextResponse.json({ status: "failed", error: "Could not send email" }, { status: 502 });
  if (outcome === "unknown") return NextResponse.json({ status: "unknown", error: UNKNOWN_MESSAGE }, { status: 502 });
  return NextResponse.json({ status: "sent" });
}

const UNKNOWN_MESSAGE = "We couldn't confirm whether this email was sent. Don't send it again yet: an administrator can check and settle it in Email history.";
