// Platform > App connections > "Test connection": the plain words for what a real sign-in round trip found. Browser-safe (no server code).

export type AppTestOutcome = "ok" | "redirect_mismatch" | "bad_secret" | "bad_client_id" | "consent_blocked" | "wrong_account" | "denied" | "expired" | "failed";
export const APP_TEST_OUTCOMES: readonly AppTestOutcome[] = ["ok", "redirect_mismatch", "bad_secret", "bad_client_id", "consent_blocked", "wrong_account", "denied", "expired", "failed"];
const NAME = { xero: "Xero", microsoft: "Microsoft 365" } as const;

export function isAppTestOutcome(value: string | null | undefined): value is AppTestOutcome {
  return APP_TEST_OUTCOMES.includes(value as AppTestOutcome);
}

export function appTestMessage(provider: "xero" | "microsoft", outcome: AppTestOutcome): string {
  const name = NAME[provider];
  switch (outcome) {
    case "ok": return `${name} app works ✓ (redirect, id and secret all accepted)`;
    case "redirect_mismatch": return `${name} doesn't accept the redirect address. Register exactly the redirect URI(s) shown above at ${name}, then test again.`;
    case "bad_secret": return `${name} rejected the client secret. Paste the secret's value again and save, then test again.`;
    case "bad_client_id": return `${name} doesn't recognise that client id. Check it is the id of the app you registered, save, then test again.`;
    case "consent_blocked": return `${name} needs an administrator to approve the app first. Ask the administrator to approve it for the account you signed in with, then test again.`;
    case "wrong_account": return `${name} doesn't accept that kind of account. Sign in with a work or school account that can use the app.`;
    case "denied": return `The ${name} sign-in was cancelled, so nothing was tested.`;
    case "expired": return "That test took too long or was already used. Click Test connection again.";
    default: return `The ${name} test didn't complete. Nothing was saved. Try again.`;
  }
}

/** Shown under the button: Microsoft and Xero show their own error page (and never come back) when the redirect address isn't registered. */
export const APP_TEST_NOTE = "If the provider shows an error page and does not bring you back, the redirect URI above is not registered there exactly as shown. Nothing is saved by a test.";
