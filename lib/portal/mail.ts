import "server-only";
import { randomUUID } from "crypto";

import { checkInput, resendFromEnv, type CompanyEmailDeps } from "@/lib/email/send-company-email";

/**
 * BOUNDARY: lib/portal/mail.ts. Input: one sign-in e-mail's recipient, names, link and code. Output: true only if Resend accepted it.
 * Sent through the PLATFORM's Resend account (resendFromEnv: RESEND_API_KEY + verified EMAIL_FROM) after checkInput (which keeps the
 * preview-deployment recipient allowlist). NEVER sendCompanyEmail, a company's Microsoft 365 mailbox, or email_history: a code must not
 * sit in a company's Sent Items or history. Nothing about the message (address, link, code) is logged; every failure is just `false`.
 * The template text is a draft pending PM approval. Must not be called with anything but a link built from NEXT_PUBLIC_SITE_URL.
 */
export type PortalMailInput = { to: string; companyName: string; customerName: string; link: string; code: string };
export type PortalMailDeps = Pick<CompanyEmailDeps, "providers"> & { env?: Record<string, string | undefined> };

/** checkInput needs a company id; the portal's platform mail has none, so a fixed marker is used (never stored). */
const PLATFORM_MARKER = "portal-platform";

export const PORTAL_MAIL_SUBJECT = "Your sign-in link and code";

export function portalMailText(input: Omit<PortalMailInput, "to">): string {
  return [
    `You asked to sign in to the customer portal of ${input.companyName} (${input.customerName}).`, "",
    "Open this link, then type the code below:", input.link, "",
    `Your code: ${input.code.slice(0, 4)} ${input.code.slice(4)}`, "",
    "The code works once and expires in 10 minutes. We will never ask you for it by phone or reply. If you didn't ask for it, ignore this e-mail.",
  ].join("\n");
}

export async function sendPortalSigninEmail(input: PortalMailInput, deps: PortalMailDeps = {}): Promise<boolean> {
  try {
    const env = deps.env ?? process.env;
    const provider = resendFromEnv(env, { providers: deps.providers });
    if (!provider) return false;
    const checked = checkInput({ organizationId: PLATFORM_MARKER, userId: null, kind: "alert", to: [input.to], subject: PORTAL_MAIL_SUBJECT, text: portalMailText(input) }, env);
    if ("error" in checked) return false;
    const result = await provider.send({ ...checked.email, idempotencyKey: `portal-signin/${randomUUID()}` });
    return result.outcome === "accepted";
  } catch {
    return false;
  }
}
