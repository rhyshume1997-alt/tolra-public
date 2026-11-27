/**
 * Inputs: service-role admin client, user identifier (email or username), redirect URL, and password-reset sender callback.
 * Outputs: discriminated result ("done" | "unavailable") distinguishing genuine unknown accounts from lookup or delivery failures.
 * Boundary: Module 1 (Auth & Admin) only; preserves anti-enumeration on unknown accounts while failing closed on real lookup/delivery failures.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { LoginLookupError, resolveLoginEmail } from "@/lib/server/login";

export const RESET_UNAVAILABLE_MESSAGE = "Password reset is temporarily unavailable. Try again shortly.";

export type PasswordResetOutcome =
  | { kind: "done" }
  | { kind: "unavailable"; reason: "lookup_failed" | "delivery_failed" };

export type ResetEmailSender = (
  email: string,
  redirectTo: string,
) => Promise<{ error: { status?: number; message?: string } | null }>;

/**
 * Resolves the identifier to an email (when it is a username) and triggers reset email delivery.
 * - Unknown username (`email === null`): returns `{ kind: "done" }` so account existence is never disclosed.
 * - Lookup outage (`LoginLookupError`) or reset email delivery error/throw: logs and returns `{ kind: "unavailable" }`
 *   so callers return HTTP 503 instead of falsely telling the user an email was sent.
 */
export async function executePasswordReset(
  admin: SupabaseClient | null,
  identifier: string,
  redirectTo: string,
  sendResetEmail: ResetEmailSender,
): Promise<PasswordResetOutcome> {
  let email: string | null;
  try {
    email = await resolveLoginEmail(admin, identifier);
  } catch (err) {
    if (err instanceof LoginLookupError) {
      console.error("[auth/reset] login lookup failed");
      return { kind: "unavailable", reason: "lookup_failed" };
    }
    throw err;
  }

  if (!email) {
    return { kind: "done" };
  }

  try {
    const { error } = await sendResetEmail(email, redirectTo);
    if (error) {
      console.error("[auth/reset] reset email failed", error.status ?? "unknown");
      return { kind: "unavailable", reason: "delivery_failed" };
    }
    return { kind: "done" };
  } catch (err) {
    console.error("[auth/reset] reset email threw", err instanceof Error ? err.name : "unknown");
    return { kind: "unavailable", reason: "delivery_failed" };
  }
}
