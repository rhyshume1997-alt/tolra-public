import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * "Must change password" bookkeeping (audit B0a: SEC3, A9).
 *
 * Two markers live in the login's app_metadata, which only the service role can write:
 *   temp_password_set_at  - written in the same Auth call that sets an admin-chosen password;
 *   password_changed_at   - written right after the person chose their own password.
 * When the second is later than the first, the person has provably replaced the temporary password, so a failed
 * flag write can be finished later without asking them to change the password a second time.
 */
export type PasswordMarkers = { temp_password_set_at?: string; password_changed_at?: string };

export function markers(appMetadata: unknown): PasswordMarkers {
  const meta = (appMetadata ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof meta[key] === "string" ? (meta[key] as string) : undefined);
  return { temp_password_set_at: text("temp_password_set_at"), password_changed_at: text("password_changed_at") };
}

/** True when the person changed their password after the last admin-set temporary password. */
export function changedAfterTemporary(meta: PasswordMarkers): boolean {
  if (!meta.password_changed_at) return false;
  if (!meta.temp_password_set_at) return true;
  return Date.parse(meta.password_changed_at) > Date.parse(meta.temp_password_set_at);
}

// The same rule the "Choose your password" page uses to decide whether to show its form (it has no current-password field).
export { LINK_SIGN_IN_MAX_AGE_S, recentLinkSignIn } from "@/lib/set-password-link";

/** Runs a write up to `attempts` times; true once it succeeds. For short, idempotent writes only. */
export async function persist(write: () => PromiseLike<{ error: unknown }>, attempts = 3): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const { error } = await write();
    if (!error) return true;
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
  }
  return false;
}

/** Sets or clears must_change_password; true once the row really holds the value. */
export async function setMustChange(admin: SupabaseClient, userId: string, value: boolean) {
  return persist(async () => {
    const { data, error } = await admin.from("user_profiles").update({ must_change_password: value }).eq("id", userId).select("must_change_password");
    if (error) return { error };
    // No profile row: nothing to clear is fine, but a requirement that couldn't be stored is a failure.
    if (!data?.length) return { error: value ? new Error("profile not found") : null };
    return { error: data[0].must_change_password === value ? null : new Error("profile not updated") };
  });
}
