import "server-only";

// G1 (migration 137): Supabase Auth changes a password only when the app's server has issued a single-use ticket for that login
// (security_audit.password_change_tickets; a trigger on auth.users refuses any other change and uses the ticket up). A route issues
// one with the service role AFTER all of its own checks have passed, right before it asks Auth to change the password, and drops it
// afterwards if Auth did not use it. A direct call to Auth with a person's own token (PUT /auth/v1/user) has no ticket and is refused.

type RpcError = { code?: string; message?: string } | null;
type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: RpcError }> };

export type TicketPurpose = "own_change" | "admin_set";
/** ok: the change may be sent to Auth (`ticket` null before 137 is applied: no ticket exists or is needed). */
export type TicketOutcome = { ok: true; ticket: string | null } | { ok: false };

/** PostgREST's "no such function" (schema cache) and Postgres's undefined_function: the database does not have 137 yet. */
const NOT_APPLIED = new Set(["PGRST202", "42883"]);

export async function issuePasswordChangeTicket(admin: RpcClient, userId: string, purpose: TicketPurpose): Promise<TicketOutcome> {
  try {
    const { data, error } = await admin.rpc("issue_password_change_ticket", { p_user_id: userId, p_purpose: purpose });
    if (error) {
      // Before 137 there is no ticket function and no trigger, so nothing asks for one. Any other refusal: nothing is sent to Auth.
      if (error.code && NOT_APPLIED.has(error.code)) return { ok: true, ticket: null };
      console.error("[password-ticket] issue failed", error.code ?? "no-code");
      return { ok: false };
    }
    if (typeof data !== "string" || !data) {
      console.error("[password-ticket] issue returned no ticket");
      return { ok: false };
    }
    return { ok: true, ticket: data };
  } catch (thrown) {
    console.error("[password-ticket] issue failed", thrown instanceof Error ? thrown.name : "thrown");
    return { ok: false };
  }
}

/** Drops the ticket if Auth did not use it (a used one stays as history). Best effort: an unused ticket expires within 60 seconds anyway. */
export async function revokePasswordChangeTicket(admin: RpcClient, ticket: string | null): Promise<void> {
  if (!ticket) return;
  try {
    const { error } = await admin.rpc("revoke_password_change_ticket", { p_ticket: ticket });
    if (error) console.error("[password-ticket] revoke failed", error.code ?? "no-code");
  } catch {
    console.error("[password-ticket] revoke failed");
  }
}
