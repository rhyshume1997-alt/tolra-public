import { parseSender } from "@/lib/email/sender";
export { parseSender } from "@/lib/email/sender";

/**
 * Admin > Integrations > Resend: what the server's Resend settings let us say. Pure apart from the optional live check, so it is unit tested.
 *   not_configured  neither RESEND_API_KEY nor EMAIL_FROM is set;
 *   configured      both are set and look right (no live check yet, or the key can only send so Resend can't be asked about domains);
 *   connected       a live check found the key accepted and the sender's domain verified in Resend;
 *   error           half set, an unusable sender address, a refused key, or a sender domain Resend has not verified.
 */
export type ResendState = "not_configured" | "configured" | "connected" | "error";
export type ResendStatus = { state: ResendState; message: string; sender: string | null };

type DomainsAnswer = { data?: { data?: Array<{ name?: string; status?: string }> } | null; error?: { name?: string; statusCode?: number | null } | null };
export type ResendDomainsClient = { domains: { list: () => Promise<DomainsAnswer> } };

/** The settings alone: no call to Resend. The key's value is never returned. */
export function resendConfigStatus(env: Record<string, string | undefined> = process.env): ResendStatus {
  const key = env.RESEND_API_KEY?.trim();
  const rawFrom = env.EMAIL_FROM?.trim();
  if (!key && !rawFrom) return { state: "not_configured", message: "Not set up: add the Resend API key and a verified sender address on the server. Until then e-mails are saved as drafts.", sender: null };
  if (!key) return { state: "error", message: "The sender address is set but the Resend API key is missing.", sender: null };
  if (!rawFrom) return { state: "error", message: "The Resend API key is set but the verified sender address is missing.", sender: null };
  const sender = parseSender(rawFrom);
  if (!sender) return { state: "error", message: "The sender address isn't a valid e-mail address.", sender: null };
  return { state: "configured", message: "Set up. Use Test to confirm Resend accepts the key and the sender's domain is verified.", sender: sender.address };
}

/** The settings plus one read-only call to Resend (GET /domains): no e-mail is sent. Never throws. */
export async function checkResend(env: Record<string, string | undefined>, client: ResendDomainsClient): Promise<ResendStatus> {
  const base = resendConfigStatus(env);
  if (base.state !== "configured") return base;
  const domain = parseSender(env.EMAIL_FROM)!.domain;
  let answer: DomainsAnswer;
  try {
    answer = await client.domains.list();
  } catch {
    return { ...base, state: "error", message: "Couldn't reach Resend. Try again." };
  }
  const err = answer.error;
  if (err) {
    // A send-only key may not list domains: it can still send, so that is not a fault, just not confirmable.
    if (err.name === "restricted_api_key") return { ...base, message: "Set up. This key can only send, so Resend can't confirm the sender's domain: send a test from Approvals to be sure." };
    if (err.statusCode === 401 || err.statusCode === 403 || err.name === "invalid_api_key" || err.name === "missing_api_key") return { ...base, state: "error", message: "Resend refused the API key. Check it is correct and not revoked." };
    if (err.statusCode === 429) return { ...base, message: "Resend is busy, so it couldn't be checked now. Try again in a minute." };
    return { ...base, state: "error", message: "Resend didn't answer properly. Try again." };
  }
  const found = (answer.data?.data ?? []).find((d) => d.name?.toLowerCase() === domain || domain.endsWith(`.${d.name?.toLowerCase()}`));
  if (!found) return { ...base, state: "error", message: `The domain ${domain} isn't in this Resend account. Add and verify it in Resend, or change the sender address.` };
  if (found.status !== "verified") return { ...base, state: "error", message: `The domain ${found.name} isn't verified in Resend yet (${found.status ?? "unknown"}). Finish the DNS records in Resend.` };
  return { ...base, state: "connected", message: `Connected: Resend accepts the key and ${found.name} is verified. Sending as ${base.sender}.` };
}
