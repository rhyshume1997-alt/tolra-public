import "server-only";

import { MICROSOFT_LOGIN, MICROSOFT_SCOPES } from "@/lib/integrations/microsoft/oauth";
import { ADMIN_CONSENT_TTL_SECONDS, signState } from "@/lib/integrations/signed-state";

// "Ask your Microsoft admin to approve" (C2). When a company's own Microsoft sign-in is stopped because an administrator must approve
// Tolra first, the admin gets a link for the company's Microsoft administrator. The link is Microsoft's admin-consent page for Tolra's
// app (scope https://graph.microsoft.com/.default, as the v2 endpoint requires; the plain words come from MICROSOFT_SCOPES), and it comes back to the one callback
// Microsoft already knows (/api/integrations/microsoft/callback) carrying a signed, company-bound, expiring, one-use state.

/** Microsoft's own wording for "an administrator must approve this app first", wherever it shows (error, error_description). */
export const CONSENT_BLOCKED_RE = /AADSTS65001|AADSTS90094|admin_consent_required|consent_required|need admin approval/i;

/** True when any of the given texts (the callback's `error` and `error_description`) says an administrator must approve first. */
export function isConsentBlocked(...texts: Array<string | null | undefined>): boolean {
  return texts.some((text) => typeof text === "string" && CONSENT_BLOCKED_RE.test(text));
}

/** Plain words for each scope. A scope with no entry is shown by its own name, so a new scope is never hidden from the administrator. */
export const SCOPE_WORDS: Readonly<Record<string, string>> = {
  offline_access: "Stay signed in",
  "Mail.Send": "Send mail as you",
  "User.Read": "Read your profile",
  "Mail.Read": "Read your mail",
};

export type Permission = { scope: string; text: string };

/** The permissions the administrator is asked to approve, in plain words, from the SAME constant the sign-in uses. */
export function permissionsFor(scopes: readonly string[] = MICROSOFT_SCOPES): Permission[] {
  return scopes.map((scope) => ({ scope, text: SCOPE_WORDS[scope] ?? scope }));
}

/**
 * Microsoft's v2 adminconsent endpoint takes ONE scope of the form `<resource>/.default`: the administrator approves every permission
 * the app registration lists for Microsoft Graph. Individual scopes (Mail.Send, offline_access) are not accepted there. The plain-words
 * list shown to the administrator is still derived from MICROSOFT_SCOPES (permissionsFor), which the sign-in asks for.
 */
export const ADMIN_CONSENT_SCOPE = "https://graph.microsoft.com/.default";

/** Microsoft's admin-consent URL for Tolra's app: Graph's `.default` scope, our callback, and the signed state. */
export function adminConsentUrl(app: { clientId: string; redirectUri: string }, state: string): string {
  const url = new URL(`${MICROSOFT_LOGIN}/organizations/v2.0/adminconsent`);
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("scope", ADMIN_CONSENT_SCOPE);
  url.searchParams.set("redirect_uri", app.redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

/** A mailto: for the administrator: the plain-words permissions and the link. */
export function consentMailto(url: string, company: string | null, permissions: readonly Permission[]): string {
  const subject = `Please approve Tolra for ${company ?? "our company"} in Microsoft 365`;
  const body = [
    "Hello,", "",
    `Tolra (our business software) needs a Microsoft 365 administrator to approve it once, so it can use ${company ?? "our company"}'s mailbox.`, "",
    "It asks for these permissions only:", ...permissions.map((p) => `- ${p.text}`), "",
    "Please open this link and choose Accept:", url, "",
    "The link works once and expires in 24 hours. Thank you.",
  ].join("\n");
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export type ConsentLink = { url: string; mailto: string; permissions: Permission[]; expiresAt: string };

/** A new link for one company, made by one of its admins. */
export function newConsentLink(app: { clientId: string; redirectUri: string }, key: Buffer, ctx: { org: string; userId: string; company: string | null }, now: number = Date.now()): ConsentLink {
  const { state, payload } = signState({ k: "admin_consent", p: "microsoft", o: ctx.org, u: ctx.userId, ttlSeconds: ADMIN_CONSENT_TTL_SECONDS }, key, now);
  const url = adminConsentUrl(app, state);
  const permissions = permissionsFor();
  return { url, mailto: consentMailto(url, ctx.company, permissions), permissions, expiresAt: new Date(payload.e * 1000).toISOString() };
}
