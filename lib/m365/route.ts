import "server-only";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";

import { clientIp, forbiddenOrigin, isErrorResponse, jsonError, requireProfile, sameOrigin, type AuthContext } from "@/lib/server/auth";
import { GraphError, mailConfig, type MailConfig } from "@/lib/m365/graph";

// Shared by the /api/mail routes: admin of the one company that owns the mailbox, same origin, Microsoft 365
// configured, and every send reserved before it is made and recorded after.

export const NOT_CONFIGURED = "Microsoft 365 mail is not configured";
export const UNCERTAIN = "Already sent or outcome unknown — check Sent Items before retrying";

export type MailContext = { auth: AuthContext; config: MailConfig };

/** 403 unless the caller is an admin of MS_ORGANIZATION_ID. Nothing is sent to Microsoft before this has passed. */
export async function mailGuard(request: Request): Promise<MailContext | NextResponse> {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile(["admin"]);
  if (isErrorResponse(auth)) return auth;
  return legacyMailContext(auth);
}

/** The legacy app-only mailbox (LEGACY, lib/m365/graph.ts) for an admin already checked: configured, and theirs. */
export function legacyMailContext(auth: AuthContext): MailContext | NextResponse {
  let config: MailConfig | null;
  try {
    config = mailConfig();
  } catch (err) {
    return jsonError(err instanceof GraphError ? err.message : NOT_CONFIGURED, 503);
  }
  if (!config) return jsonError(NOT_CONFIGURED, 503);
  // The mailbox belongs to one company; another company's admin must not read it or send as it.
  if (auth.profile.organization_id !== config.organizationId) return jsonError("Forbidden", 403);
  return { auth, config };
}

/** Route response for a failed Graph call: the safe message only. */
export function graphFailure(route: string, err: unknown) {
  if (err instanceof GraphError) {
    console.error(`[${route}] graph error`, err.code);
    return jsonError(err.message, err.status === 429 ? 429 : err.status === 422 ? 422 : 502);
  }
  console.error(`[${route}] failed`, err instanceof Error ? err.name : "unknown");
  return jsonError("Microsoft 365 mail is unavailable. Try again shortly.", 502);
}

const clean = (value: unknown) => (typeof value === "string" ? value.trim().toLowerCase() : "");

/**
 * Who this mailbox may write to. EMAIL_RECIPIENT_DOMAINS (as send-job: "example.com" allows a domain, "a@example.com"
 * one address) is a strict list when it is set, so a preview deployment can only reach its test domains. When it is not
 * set, the address must already be known: a customer or RFQ e-mail in this organisation.
 */
export async function recipientAllowed(auth: AuthContext, email: string): Promise<boolean> {
  const address = clean(email);
  const entries = (process.env.EMAIL_RECIPIENT_DOMAINS || "").split(",").map(clean).filter(Boolean);
  if (entries.length) {
    const domain = address.split("@")[1] ?? "";
    return entries.some((entry) => (entry.includes("@") ? entry === address : entry.replace(/^@/, "") === domain));
  }
  const org = auth.profile.organization_id;
  for (const table of ["customers", "rfqs"] as const) {
    const { data } = await auth.supabase.from(table).select("email").eq("organization_id", org).ilike("email", address.replace(/[\\%_]/g, "\\$&")).limit(1);
    if ((data ?? []).some((row) => clean(row.email) === address)) return true;
  }
  return false;
}

/** Every address must pass recipientAllowed. */
export async function allRecipientsAllowed(auth: AuthContext, addresses: string[]): Promise<boolean> {
  for (const address of addresses) if (!(await recipientAllowed(auth, address))) return false;
  return true;
}

/** Idempotency key the server computes: the same e-mail (kind, target or recipients, subject, body) has the same key. */
export function mailKey(kind: "send" | "reply" | "forward", target: string | string[], subject: string, body: string): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return createHash("sha256").update(JSON.stringify([kind, target, subject, bodyHash])).digest("hex");
}

/**
 * Reserves the send (limit and key checked atomically in the database, migration 031), sends it, then records the
 * outcome: accepted (Microsoft answered 202: accepted for sending, not delivered), failed (a definite refusal, may be
 * retried) or unknown (it may have been sent: refused until an admin has checked Sent Items).
 */
export async function sendAndLog(
  ctx: MailContext,
  request: Request,
  route: string,
  mail: { kind: "send" | "reply" | "forward"; key: string; recipients: string[]; subject: string; body: string; rfqId?: string | null },
  send: () => Promise<void>,
) {
  const { supabase } = ctx.auth;
  const { data: reservation, error: reserveError } = await supabase.rpc("reserve_mail_send", {
    p_kind: mail.kind,
    p_key: mail.key,
    p_recipients: mail.recipients,
    p_subject: mail.subject,
    p_body: mail.body,
    p_rfq: mail.rfqId ?? null,
  });
  if (reserveError) {
    if (reserveError.code === "PT429") return jsonError(reserveError.message, 429);
    if (reserveError.code === "PT409") return NextResponse.json({ status: "unknown", error: UNCERTAIN }, { status: 409 });
    console.error(`[${route}] reservation failed`, reserveError.code);
    return jsonError("Could not send email", 500);
  }
  const { send_id: sendId, history_id: historyId } = reservation as { send_id: string; history_id: string };

  let outcome: "accepted" | "failed" | "unknown" = "accepted";
  let failure: unknown;
  try {
    await send();
  } catch (err) {
    failure = err;
    // Anything that isn't a definite refusal might have been sent.
    outcome = err instanceof GraphError && err.outcome === "failed" ? "failed" : "unknown";
    console.error(`[${route}] send ${outcome}`, err instanceof GraphError ? err.code : err instanceof Error ? err.name : "unknown");
  }
  const { error: completeError } = await supabase.rpc("complete_mail_send", { p_id: sendId, p_outcome: outcome });
  if (completeError) {
    // The outcome could not be written, so the reservation stays 'sending' and becomes 'unknown' once it is stale
    // (migration 031): whatever happened, the caller is told it is unknown.
    console.error(`[${route}] outcome not recorded`, completeError.code);
    outcome = "unknown";
  }

  if (outcome === "unknown") return NextResponse.json({ status: "unknown", error: "Outcome unknown — check Sent Items before retrying", send_id: sendId }, { status: 502 });
  if (outcome === "failed") return graphFailure(route, failure);

  const { error: auditError } = await supabase.rpc("write_audit", {
    p_action: "SEND",
    p_entity_table: "email_history",
    p_entity_id: historyId,
    p_old: null,
    p_new: { channel: "microsoft365", kind: mail.kind, recipients: mail.recipients },
    p_metadata: {},
    p_ip: clientIp(request),
    p_user_agent: request.headers.get("user-agent")?.slice(0, 256) ?? null,
  });
  if (auditError) console.error(`[${route}] audit failed`, auditError.code);
  return NextResponse.json({ status: "accepted", history_id: historyId, send_id: sendId });
}
