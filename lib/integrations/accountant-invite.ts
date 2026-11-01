import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { INVITE_TOKEN, escapeHtml, hashInviteToken, page, peekInvite } from "@/lib/integrations/invite";
import { serviceDb } from "@/lib/integrations/server";

// "Invite your accountant" (C3, migration 129). It REUSES 007's invite (public.organization_invites) with an expiry, a token hash, single
// use and revoke. An admin (two-step, own company, never support) makes the invite; the token is random (the same 32 bytes as the Xero
// connect link, lib/integrations/invite.ts) and only its SHA-256 is stored. The accountant opens the link signed out:
//   - the GET only shows "Join <company> on Tolra as a viewer" (accountant_invite_peek: nothing used up, so a mail scanner never burns it);
//   - "I have a Tolra login" (POST): signed in with the invite's e-mail, redeem_accountant_invite makes them a viewer of that company, once;
//   - "I'm new to Tolra" (POST): Supabase Auth e-mails that address a link to choose a password; creating the login runs the sign-up
//     trigger (129's handle_new_auth_user), which makes them a viewer and marks the invite used.
// When the admin also asked for it, the page offers "Also connect Xero for this company": the EXISTING Xero connect link (107), only while
// Xero is set up on this server, the company's Xero is not connected, and that link is still open.

export const ACCOUNTANT_INVITE_DAYS = 7;

export function accountantInviteUrl(origin: string, token: string, xeroToken?: string | null): string {
  return `${origin}/api/integrations/accountant-invite/${token}${xeroToken ? `?xero=${xeroToken}` : ""}`;
}

/** A mailto: for the admin to send the link from their own mail (Tolra sends nothing here). */
export function accountantMailto(url: string, company: string | null, email: string, withXero: boolean): string {
  const name = company ?? "our company";
  const subject = `Join ${name} on Tolra (read only)`;
  const body = [
    "Hello,", "",
    `Please use this link to see ${name}'s Tolra as a read-only viewer:`, url, "",
    `It works once, for ${email}, and expires in ${ACCOUNTANT_INVITE_DAYS} days.`,
    ...(withXero ? ["", "The same page also lets you connect our Xero to Tolra (that step works for 24 hours)."] : []),
    "", "Thank you.",
  ].join("\n");
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export type OpenAccountantInvite = { companyName: string; email: string; expiresAt: string; xeroConnected: boolean };

/** An open invite (not used, revoked or expired; company active), or null. Nothing is used up. */
export async function peekAccountantInvite(service: SupabaseClient, token: string): Promise<OpenAccountantInvite | null> {
  if (!INVITE_TOKEN.test(token)) return null;
  const out = await serviceDb(service).rpc<{ company_name?: unknown; email?: unknown; expires_at?: unknown; xero_connected?: unknown } | null>(
    "accountant_invite_peek", { p_token_hash: hashInviteToken(token) });
  if (!out || typeof out.company_name !== "string" || typeof out.email !== "string") return null;
  return { companyName: out.company_name, email: out.email, expiresAt: String(out.expires_at ?? ""), xeroConnected: out.xero_connected === true };
}

/** The Xero connect link to offer, or null: only a well-formed link that is still open (107), when the company's Xero isn't connected. */
export async function xeroOfferFor(service: SupabaseClient, xeroToken: string | null, invite: { xeroConnected: boolean } | null, xeroIsReady: boolean): Promise<string | null> {
  if (!xeroToken || !INVITE_TOKEN.test(xeroToken) || !xeroIsReady || !invite || invite.xeroConnected) return null;
  const open = await peekInvite(service, xeroToken).catch(() => null);
  return open ? `/api/integrations/invite/${xeroToken}` : null;
}

/** "a***@firm.example": enough for the accountant to recognise the address, not the whole of it. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "your e-mail";
  return `${local[0]}***@${domain}`;
}

export type AccountantOutcome =
  | "joined" | "already_member" | "check_email" | "has_login" | "sign_in_first" | "other_email" | "membership_inactive" | "mfa_required"
  | "invalid" | "busy" | "not_configured" | "failed";

const OUTCOME: Record<AccountantOutcome, { title: string; body: string }> = {
  joined: { title: "You're in", body: "You can now see this company in Tolra as a viewer (read only). Open Tolra and choose the company." },
  already_member: { title: "Already a member", body: "Your login was already a member of this company. Nothing about your access changed." },
  check_email: { title: "Check your e-mail", body: "We've sent a link to choose your password. Open it on this device; after that you'll see the company in Tolra as a viewer." },
  has_login: { title: "You already have a Tolra login", body: "Sign in to Tolra first, then open this link again and choose \"I have a Tolra login\"." },
  sign_in_first: { title: "Sign in first", body: "Sign in to Tolra in this browser with the e-mail this invite was sent to, then open this link again." },
  other_email: { title: "This invite is for another e-mail", body: "You're signed in with a different e-mail. Sign in with the address the invite was sent to, or ask for an invite to yours." },
  membership_inactive: { title: "Your access was switched off", body: "Your login was removed from this company. Ask its admin to turn your access back on." },
  mfa_required: { title: "Confirm your authenticator code first", body: "Finish signing in to Tolra (the second step), then open this link again." },
  invalid: { title: "This invite can't be used", body: `It has expired (invites last ${ACCOUNTANT_INVITE_DAYS} days), was cancelled, was already used, or was copied wrongly. Ask for a new one.` },
  busy: { title: "Try again shortly", body: "Too many attempts from here, or Tolra can't check right now. Wait a few minutes and open the link again." },
  not_configured: { title: "Not set up yet", body: "Tolra can't open invites on this server yet. Nothing was used up: try the same link later." },
  failed: { title: "That didn't work", body: "Nothing changed. Try the link again, or ask for a new one." },
};

const xeroSection = (xeroUrl: string | null) => (xeroUrl
  ? `<hr style="border:0;border-top:1px solid #e2e8f0;margin:20px 0"><h2 style="font-size:18px;margin:0 0 8px">Also connect Xero for this company</h2>`
    + `<p>The company asked you to connect its Xero to Tolra as well. This opens Xero's sign-in for this company only (the link works once, for 24 hours).</p>`
    + `<p><a href="${escapeHtml(xeroUrl)}" style="font-weight:600;color:#0b7fa8">Connect Xero</a></p>`
  : "");

/** A fixed page for an outcome (fixed text only, nothing from the request), with the Xero offer when there is one. */
export function accountantOutcomePage(outcome: AccountantOutcome, status = 200, xeroUrl: string | null = null): Response {
  const p = OUTCOME[outcome] ?? OUTCOME.failed;
  const next = outcome === "joined" || outcome === "already_member" || outcome === "has_login" || outcome === "sign_in_first" || outcome === "mfa_required"
    ? `<p><a href="/login" style="font-weight:600;color:#0b7fa8">Open Tolra</a></p>` : "";
  return page(p.title, `<h1>${p.title}</h1><p>${p.body}</p>${next}${xeroSection(xeroUrl)}`, status);
}

/** The invite's page for an open invite: the company's name, the masked e-mail and the two choices. Nothing is used up by opening it. */
export function accountantConfirmPage(invite: OpenAccountantInvite, xeroUrl: string | null): Response {
  const name = escapeHtml(invite.companyName);
  const email = escapeHtml(maskEmail(invite.email));
  return page(`Join ${name} on Tolra`,
    `<h1>Join ${name} on Tolra</h1><p>${name} invited ${email} to see its Tolra as a <strong>viewer</strong>: read only, nothing can be changed.</p>`
    + `<p>The invite works once and expires ${ACCOUNTANT_INVITE_DAYS} days after it was made.</p>`
    + `<form method="post"><input type="hidden" name="action" value="join"><button type="submit">I have a Tolra login</button></form>`
    + `<p style="font-size:14px">Sign in to Tolra in this browser first, with the e-mail the invite was sent to.</p>`
    + `<form method="post"><input type="hidden" name="action" value="new"><button type="submit" style="background:#334155">I'm new to Tolra: e-mail me a link</button></form>`
    + `<p style="font-size:14px">We e-mail ${email} a link to choose your password.</p>`
    + xeroSection(xeroUrl), 200);
}

/** The outcome for an error from redeem_accountant_invite (its HINT), never the database's own text. */
export function redeemOutcome(error: { code?: string; hint?: string | null }): AccountantOutcome {
  if (error.hint === "invite_other_email") return "other_email";
  if (error.hint === "membership_inactive") return "membership_inactive";
  if (error.hint === "mfa_required") return "mfa_required";
  if (error.hint === "invite_invalid") return "invalid";
  if (error.code === "42501") return "sign_in_first";
  return "failed";
}
