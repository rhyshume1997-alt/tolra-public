import { MFA_RECENT_CODE } from "@/lib/mfa-policy";

// Re-entering the authenticator code for a password change (G1). The server (app/api/auth/change-password) keeps enforcing that an admin's
// last code is under 15 minutes old (lib/mfa-policy.ts recentSecondStep) and answers 403 mfa_recent_required when it is not. The browser
// then asks for a fresh code with the same Supabase call the sign-in step uses (app/mfa/page.tsx: challengeAndVerify), which makes the
// session's amr carry a new totp time, and sends the change once more. Nothing here can skip the server's check: a code that did not
// verify changes nothing, and the retry is judged by the server again. Wrong codes are limited by Supabase's own MFA verify limits, as at sign-in.

/** True when the server refused a password change because the admin's authenticator code is too old (mfa_recent_required). */
export function needsRecentCode(status: number | null | undefined, body: { code?: unknown } | null | undefined): boolean {
  return status === 403 && body?.code === MFA_RECENT_CODE;
}

export const CODE_PROMPT = "Enter the 6-digit code from your authenticator app.";
export const CODE_WRONG = "That code didn't work. Check the code in your app (it changes every 30 seconds) and try again.";
export const CODE_UNAVAILABLE = "Couldn't check your code right now. Try again.";

/** The 6 digits typed (spaces allowed), or null. */
export function cleanCode(input: string): string | null {
  const code = input.replace(/\s/g, "");
  return /^\d{6}$/.test(code) ? code : null;
}

/** The part of supabase.auth.mfa this needs. */
export type MfaApi = {
  listFactors: () => PromiseLike<{ data: { totp?: Array<{ id: string }> } | null; error: unknown }>;
  challengeAndVerify: (params: { factorId: string; code: string }) => PromiseLike<{ error: unknown }>;
};

export type CodeResult = { ok: true } | { ok: false; message: string };

/** Verifies a code against the person's enrolled (verified) authenticator. Never throws. */
export async function verifyAuthenticatorCode(mfa: MfaApi | null | undefined, input: string): Promise<CodeResult> {
  const code = cleanCode(input);
  if (!code) return { ok: false, message: CODE_PROMPT };
  if (!mfa) return { ok: false, message: CODE_UNAVAILABLE };
  try {
    const { data, error } = await mfa.listFactors();
    const factor = data?.totp?.[0];
    if (error || !factor) return { ok: false, message: CODE_UNAVAILABLE };
    const { error: verifyError } = await mfa.challengeAndVerify({ factorId: factor.id, code });
    return verifyError ? { ok: false, message: CODE_WRONG } : { ok: true };
  } catch {
    return { ok: false, message: CODE_UNAVAILABLE };
  }
}

export type ChangeAnswer = { ok: boolean; status: number; body: { error?: string; code?: string } | null };
export type ChangeOutcome = { result: "changed" } | { result: "cancelled" } | { result: "failed"; status: number; error?: string };

/** What a sensitive request answered: ok, the HTTP status, and the JSON body (null when there was none). */
export type SendAnswer<B extends { code?: unknown } = { code?: unknown }> = { ok: boolean; status: number; body: B | null };
export type SendOutcome<B extends { code?: unknown } = { code?: unknown }> = { result: "done" | "failed"; answer: SendAnswer<B> } | { result: "cancelled" };

/**
 * Sends a sensitive request (a password change, or an admin action on Admin > Users: G1). If the server answers mfa_recent_required it
 * asks for a code (`requestCode` resolves true once a code verified, false when the person cancelled) and sends the same request ONCE
 * more. The retry is answered by the server like any other request: if it still refuses, that refusal is the outcome (there is no
 * second prompt and no loop). Any other answer is final at once. Cancelling sends nothing more, so nothing is changed.
 */
export async function sendWithCode<B extends { code?: unknown }>(send: () => Promise<SendAnswer<B>>, requestCode: () => Promise<boolean>): Promise<SendOutcome<B>> {
  let answer = await send();
  if (answer.ok) return { result: "done", answer };
  if (needsRecentCode(answer.status, answer.body)) {
    if (!(await requestCode())) return { result: "cancelled" };
    answer = await send();
    if (answer.ok) return { result: "done", answer };
  }
  return { result: "failed", answer };
}

/** The password change on the sidebar: sendWithCode, worded as a ChangeOutcome. */
export async function changePasswordWithCode(send: () => Promise<ChangeAnswer>, requestCode: () => Promise<boolean>): Promise<ChangeOutcome> {
  const outcome = await sendWithCode(send, requestCode);
  if (outcome.result === "cancelled") return { result: "cancelled" };
  if (outcome.result === "done") return { result: "changed" };
  return { result: "failed", status: outcome.answer.status, error: outcome.answer.body?.error };
}
