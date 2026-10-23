/**
 * What an e-mail provider's answer lets us say about a send (job e-mails, migration 033):
 *   accepted  the provider took it;
 *   failed    the provider definitely refused it (a 4xx answer with its own error body): nothing was sent, so the same
 *             request may be tried again;
 *   unknown   no answer we can trust (a network error, a timeout, a 5xx, a proxy page, a 409 "another request with this key
 *             is running"): it may or may not have been sent, so it is NOT retried automatically. An admin settles it.
 */
export type SendOutcome = "accepted" | "failed" | "unknown";

/** How long to wait for the provider before treating the outcome as unknown. */
export const SEND_TIMEOUT_MS = 15_000;

type ProviderError = { name?: string; statusCode?: number | null } | null | undefined;

/** Status codes in the 4xx range that do not prove the provider refused the e-mail. */
const NOT_A_REFUSAL = new Set([408, 409]);

export function classifyProviderError(error: ProviderError): SendOutcome {
  if (!error) return "accepted";
  const status = typeof error.statusCode === "number" ? error.statusCode : null;
  // application_error is the SDK's own wrapper for "no usable answer" (no network, an HTML error page, a 5xx).
  if (status !== null && status >= 400 && status < 500 && !NOT_A_REFUSAL.has(status) && error.name !== "application_error") return "failed";
  return "unknown";
}

/** Sends through `send`, and reports the outcome; never throws. A timeout or an exception is `unknown`. */
export async function sendWithOutcome(send: () => Promise<{ error?: ProviderError }>, timeoutMs = SEND_TIMEOUT_MS): Promise<{ outcome: SendOutcome; detail: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const result = await Promise.race([send(), timeout]);
    if (result === "timeout") return { outcome: "unknown", detail: "timeout" };
    const outcome = classifyProviderError(result?.error);
    return { outcome, detail: result?.error ? `${result.error.name ?? "error"} ${result.error.statusCode ?? ""}`.trim() : "ok" };
  } catch (err) {
    return { outcome: "unknown", detail: err instanceof Error ? err.name : "threw" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
