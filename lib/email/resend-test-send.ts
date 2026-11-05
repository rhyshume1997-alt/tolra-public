import "server-only";
import { randomUUID } from "node:crypto";

import type { EmailProvider } from "@/lib/email/providers/types";
import { checkInput, cleanAddress, resendFromEnv } from "@/lib/email/send-company-email";

/**
 * Admin > Integrations > Resend > "Send a test e-mail" (W-F3). ONE plain e-mail, fixed subject and text, to ONE address: the signed-in
 * admin's own (the route passes it from the session; nothing from the request body is ever used), so it cannot be used to write to anyone
 * else. Resend only (resendFromEnv: no provider switch, no Microsoft fallback, no new provider). The preview-deployment allowlist
 * (EMAIL_RECIPIENT_DOMAINS) still applies, through the same checkInput every company e-mail goes through.
 *
 * Rate limit: one test e-mail per company per minute, kept in this server instance's memory (no database). It is a brake on repeated
 * clicks, not a global quota: another serverless instance has its own count. The slot is taken BEFORE the send, so an uncertain outcome
 * cannot be hammered. Nothing is retried automatically, ever.
 *
 * Nothing secret is returned or logged: the key is never read into any message; the log line carries the outcome and the provider's
 * error name and status only.
 */
export const TEST_SUBJECT = "Tolra test e-mail";
export const TEST_TEXT = "This is a test e-mail from Tolra. If you can read it, Resend can send e-mail from this server. No action is needed.";
export const TEST_SEND_WINDOW_MS = 60_000;
export const UNCERTAIN_TEST_MESSAGE = "We could not confirm whether the test e-mail was sent: check your inbox before trying again. Nothing was retried.";

export type TestSendCode = "sent" | "not_configured" | "no_address" | "recipient_refused" | "invalid" | "rate_limited" | "refused" | "uncertain";
export type TestSendBody = { ok: boolean; code: TestSendCode; message: string; to?: string; retryAfterSeconds?: number };
/** outcome: set only when Resend was actually called (the route audits exactly those). */
export type TestSendResult = { status: number; body: TestSendBody; outcome: "accepted" | "failed" | "unknown" | null };

const lastSent = new Map<string, number>();
/** For tests. */
export function resetTestSendLimiter() { lastSent.clear(); }

export async function resendTestSend(
  input: { organizationId: string; adminEmail: string | null | undefined },
  deps: { env?: Record<string, string | undefined>; now?: () => number; providers?: { resend?: (apiKey: string, from: string) => EmailProvider } } = {},
): Promise<TestSendResult> {
  const env = deps.env ?? process.env;
  const now = (deps.now ?? Date.now)();
  const fail = (status: number, code: TestSendCode, message: string, extra: Partial<TestSendBody> = {}): TestSendResult => ({ status, body: { ok: false, code, message, ...extra }, outcome: null });

  const provider = resendFromEnv(env, { providers: deps.providers });
  if (!provider) return fail(409, "not_configured", "Resend isn't set up on this server: the platform owner adds the Resend key and a verified sender address. Nothing was sent.");

  const to = cleanAddress(input.adminEmail);
  if (!to) return fail(409, "no_address", "Your sign-in has no e-mail address we can send to. Nothing was sent.");

  const checked = checkInput({ organizationId: input.organizationId, userId: null, kind: "test", to: [to], subject: TEST_SUBJECT, text: TEST_TEXT }, env);
  if ("error" in checked) return fail(checked.code === "recipient_refused" ? 403 : 400, checked.code === "recipient_refused" ? "recipient_refused" : "invalid", `${checked.error} Nothing was sent.`);

  const last = lastSent.get(input.organizationId);
  if (last !== undefined && now - last < TEST_SEND_WINDOW_MS) {
    const retryAfterSeconds = Math.max(1, Math.ceil((TEST_SEND_WINDOW_MS - (now - last)) / 1000));
    return fail(429, "rate_limited", `One test e-mail a minute. Try again in ${retryAfterSeconds} seconds. Nothing was sent.`, { retryAfterSeconds });
  }
  if (lastSent.size > 500) for (const [org, at] of lastSent) if (now - at >= TEST_SEND_WINDOW_MS) lastSent.delete(org);
  lastSent.set(input.organizationId, now);

  let result: Awaited<ReturnType<EmailProvider["send"]>>;
  try {
    result = await provider.send({ ...checked.email, idempotencyKey: `resend-test/${randomUUID()}` });
  } catch {
    result = { outcome: "unknown", detail: "threw" };
  }
  if (result.outcome !== "accepted") console.error("[resend-test-send]", result.outcome, result.detail);
  if (result.outcome === "accepted") return { status: 200, body: { ok: true, code: "sent", message: `Test e-mail sent to ${to}. Check your inbox (and spam).`, to }, outcome: "accepted" };
  if (result.outcome === "failed") {
    const busy = result.rateLimited === true;
    return { status: busy ? 429 : 502, body: { ok: false, code: "refused", message: busy ? "Resend is busy. Wait a minute and try again. Nothing was sent." : "Resend refused the test e-mail. Use Check domain to see whether the key and the sender domain are accepted. Nothing was sent." }, outcome: "failed" };
  }
  return { status: 502, body: { ok: false, code: "uncertain", message: UNCERTAIN_TEST_MESSAGE }, outcome: "unknown" };
}
