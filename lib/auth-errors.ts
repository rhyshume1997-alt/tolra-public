/**
 * How a sign-in failure is described to the person. Error DISPLAY only: nothing here decides who may sign in, and the
 * server's answers for a wrong username, a wrong password and an unknown account stay identical (401, same text).
 */
import { PRODUCT } from "@/lib/product";

export const UNREACHABLE_MESSAGE = `Can't reach ${PRODUCT.name} right now. Check your connection and try again.`;
export const INVALID_CREDENTIALS_MESSAGE = "Invalid username or password.";
export const TOO_MANY_MESSAGE = "Too many attempts.";

export type SignInFailure =
  | { kind: "unreachable" }
  | { kind: "too_many"; message: string }
  | { kind: "invalid" };

/** The /api/auth/signin answer (or the fetch failing outright, status null) as the screen should treat it. */
export function classifySignInResponse(status: number | null, serverMessage?: string): SignInFailure {
  if (status === null || status === 0 || status >= 500) return { kind: "unreachable" };
  if (status === 429) return { kind: "too_many", message: serverMessage || TOO_MANY_MESSAGE };
  return { kind: "invalid" };
}

/**
 * True when a Supabase auth/database error means "the service could not be reached or failed" rather than "the answer was no":
 * a thrown fetch, an auth-js retryable fetch error, status 0 or 5xx.
 */
export function isUnreachableError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { name, status, message } = err as { name?: unknown; status?: unknown; message?: unknown };
  if (name === "AuthRetryableFetchError" || err instanceof TypeError) return true;
  if (typeof status === "number" && (status === 0 || status >= 500)) return true;
  return typeof message === "string" && /failed to fetch|networkerror|network request failed|load failed/i.test(message);
}

/** The slice of the Supabase auth client that confirming a local sign-out needs. */
type SignOutClient = {
  signOut: (options: { scope: "local" }) => PromiseLike<{ error: unknown }>;
  getSession: () => PromiseLike<{ data: { session: unknown | null }; error: unknown }>;
};

/**
 * Removes this browser's session and says whether it is really gone: true when signOut({scope:'local'}) succeeded, or
 * when it failed but getSession() then shows no session. False (a live session may remain) on anything else, so the
 * caller stays put and tells the person instead of leaving a signed-in device behind.
 */
export async function confirmLocalSignOut(auth: SignOutClient): Promise<boolean> {
  try {
    const { error } = await auth.signOut({ scope: "local" });
    if (!error) return true;
  } catch { /* checked below */ }
  try {
    const { data, error } = await auth.getSession();
    return !error && !data.session;
  } catch {
    return false;
  }
}
