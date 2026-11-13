import "server-only";
import { randomUUID } from "crypto";
import { NextResponse } from "next/server";

import type { PortalRefusal } from "./types";

/**
 * BOUNDARY: lib/portal/refusal.ts. One refusal for everything: one shape (PortalRefusal), one HTTP status (403), one fixed page text.
 * It never says whether a contact, code, document or account exists, or why. Logging holds ONLY the correlation id (no e-mail, name, IP,
 * code, ref or token). Refusals made here (flag off, bad input, limiter) get a fresh random id; database refusals carry the database's.
 * Must not add a second status, a reason, or any caller-supplied text.
 */
export const PORTAL_REFUSAL_STATUS = 403;
export const PORTAL_REFUSAL_TITLE = "We couldn't sign you in";
export const PORTAL_REFUSAL_MESSAGE = "This link or code didn't work. Ask the company that invited you to send a new sign-in link.";

export const portalRefusal = (correlationId: string = randomUUID()): PortalRefusal => ({ ok: false, reason: "refused", correlationId });

/** Logs the correlation id and nothing else. */
export function logPortalRefusal(correlationId: string): void {
  console.error("[portal] refused", correlationId);
}

export function portalRefusalResponse(refusal: PortalRefusal = portalRefusal()): NextResponse {
  return NextResponse.json({ ok: false, reason: "refused", correlationId: refusal.correlationId }, { status: PORTAL_REFUSAL_STATUS, headers: { "Cache-Control": "no-store" } });
}
