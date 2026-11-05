import { type SendAnswer, sendWithCode } from "@/lib/mfa-step-up";

/**
 * POST to an integration action route (connect, disconnect, approval link) and, if the server answers mfa_recent_required, ask for a fresh
 * authenticator code (`requestCode`, from useCodePrompt) and send the same request ONCE more (lib/mfa-step-up.ts sendWithCode). Same
 * result shape as postIntegration. Cancelling the code sends nothing more; the server judges the retry like any other request.
 */
export type PostResult = { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

export async function postIntegrationWithCode(path: string, requestCode: () => Promise<boolean>): Promise<PostResult> {
  const outcome = await sendWithCode<Record<string, unknown>>(async (): Promise<SendAnswer<Record<string, unknown>>> => {
    const res = await fetch(path, { method: "POST", credentials: "same-origin" }).catch(() => null);
    const body = res ? ((await res.json().catch(() => ({}))) as Record<string, unknown>) : {};
    return { ok: Boolean(res?.ok), status: res?.status ?? 0, body };
  }, requestCode);
  if (outcome.result === "cancelled") return { ok: false, error: "Cancelled. Nothing was changed." };
  const { answer } = outcome;
  if (outcome.result === "done") return { ok: true, body: answer.body ?? {} };
  return { ok: false, error: typeof answer.body?.error === "string" ? answer.body.error : "That didn't work. Try again." };
}
