import "server-only";

import { type CompanyEmailDeps, checkInput, selectProvider, sendCompanyEmail } from "@/lib/email/send-company-email";

/**
 * The two e-mails of the accountant's Xero connect invite. Both go through the company's own provider selection (its connected Microsoft 365
 * mailbox, else Resend from this deployment's settings; EMAIL_PROVIDER=mock only in tests and local runs): NEVER a fallback, and if nothing
 * can send, the answer is a plain "not sent" so the caller fails closed. A "drafted" e-mail (no provider) is NOT a sent e-mail.
 *
 *  - the link e-mail (admin's request): the opaque link only, through the company mailer, so it is in the company's e-mail history;
 *  - the code e-mail (public page): the one-time code, sent straight through the selected provider and NOT recorded in e-mail history
 *    (the history keeps message bodies, and a code kept there could be read by anyone who can read that history). It is never logged.
 * Errors here are fixed sentences: no address, link or code is ever put in one.
 */
export type InviteMailResult = { ok: true } | { ok: false; error: string };

const NOT_SENT = "The e-mail could not be sent, so nothing was made. Check the company's e-mail settings (Microsoft 365 or Resend) and try again.";

export async function sendInviteLinkEmail(
  input: { organizationId: string; userId: string; inviteId: string; to: string; companyName: string; url: string },
  deps: CompanyEmailDeps = {},
): Promise<InviteMailResult> {
  const text = [
    `${input.companyName} has asked you to connect its Xero organisation to Tolra.`, "",
    "Open this link, ask for a code (it is e-mailed to this address only), and follow the steps:", input.url, "",
    "The link works once and expires in 24 hours. It gives no access to Tolra. If you weren't expecting this, ignore this e-mail.",
  ].join("\n");
  const out = await sendCompanyEmail({
    organizationId: input.organizationId, userId: input.userId, kind: "alert", to: [input.to], subject: `${input.companyName}: connect Xero to Tolra`, text,
    recordType: "general", idempotencyKey: `xero-invite-link:${input.inviteId}`, requireLedger: true,
  }, deps).catch(() => null);
  return out && out.ok && out.mode === "sent" ? { ok: true } : { ok: false, error: out && !out.ok && out.code === "no_provider" ? "No e-mail sending is set up for this company, so the invite was not sent." : NOT_SENT };
}

export async function sendInviteCodeEmail(
  input: { organizationId: string; to: string; companyName: string; code: string },
  deps: CompanyEmailDeps = {},
): Promise<InviteMailResult> {
  const env = deps.env ?? process.env;
  const checked = checkInput({
    organizationId: input.organizationId, userId: null, kind: "alert", to: [input.to], subject: "Your Tolra connect code",
    text: [`Your code to connect ${input.companyName} to Xero is:`, "", `    ${input.code.slice(0, 4)} ${input.code.slice(4)}`, "",
      "It works once, for 15 minutes. Tolra will never ask you for it by phone or reply. If you didn't ask for it, ignore this e-mail."].join("\n"),
  }, env);
  if ("error" in checked) return { ok: false, error: NOT_SENT };
  try {
    const provider = deps.provider ?? await selectProvider(input.organizationId, { ...deps, env });
    if (!provider || provider === "refused") return { ok: false, error: NOT_SENT };
    const result = await provider.send(checked.email);
    return result.outcome === "accepted" ? { ok: true } : { ok: false, error: NOT_SENT };
  } catch {
    return { ok: false, error: NOT_SENT };
  }
}
