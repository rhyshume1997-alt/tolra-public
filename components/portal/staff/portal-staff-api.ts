import type { SendAnswer } from "@/lib/mfa-step-up";

/**
 * BOUNDARY: browser helper for the portal staff cards. Sends JSON to app/api/portal/staff/* and returns the SendAnswer shape that
 * sendWithCode (lib/mfa-step-up.ts) reads. Holds no e-mail, name or reason beyond the one request. Must not log or store any value.
 */
export async function staffRequest<B extends { code?: unknown; error?: string }>(method: "GET" | "POST", url: string, body?: unknown): Promise<SendAnswer<B>> {
  const res = await fetch(url, {
    method, credentials: "same-origin", cache: "no-store",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => null);
  if (!res) return { ok: false, status: 0, body: null };
  return { ok: res.ok, status: res.status, body: (await res.json().catch(() => null)) as B | null };
}
