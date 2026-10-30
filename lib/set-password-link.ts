import type { EmailOtpType } from "@supabase/supabase-js";

// The e-mail link that opens "Choose your password" (app/auth/set-password/page.tsx), read and judged before anything is verified
// (audit C3). A link replaces the browser's session, so a link someone else sent could sign this browser in as THEIR account (login
// CSRF), or swap a signed-in person's session for theirs. So: only invite and password-reset links are accepted, and when another
// account is already signed in here the person is asked first and is never swapped silently.

/** The only link types accepted: an invite, or a password reset. Signup, magic link and e-mail links are refused. */
export const LINK_TYPES = ["invite", "recovery"] as const satisfies readonly EmailOtpType[];
export type LinkType = (typeof LINK_TYPES)[number];

export type SetPasswordLink =
  /** ?token_hash=...&type=... (custom e-mail template). Whose link it is can't be known before it is verified. */
  | { kind: "otp"; tokenHash: string; type: LinkType }
  /** #access_token=...&refresh_token=...&type=... (implicit tokens). userId and email are read from the token, unverified. */
  | { kind: "tokens"; accessToken: string; refreshToken: string; type: LinkType; userId: string | null; email: string | null };

const isLinkType = (value: string | null): value is LinkType => (LINK_TYPES as readonly string[]).includes(value ?? "");

/** The access token's claims, unverified (only to say whose link it is; the server checks the token when it is used). */
function tokenClaims(token: string): { sub?: unknown; email?: unknown } {
  try {
    const part = token.split(".")[1] ?? "";
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const claims: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))));
    return claims && typeof claims === "object" ? (claims as { sub?: unknown; email?: unknown }) : {};
  } catch {
    return {};
  }
}

/**
 * The link in the address (`search` and `hash` as in window.location), "refused" for a link of any other type, or null when there is
 * none (?required=1, or ?code=..., which supabase-js exchanges itself and which only works in the browser that asked for it).
 */
export function readSetPasswordLink(search: string, hash: string): SetPasswordLink | "refused" | null {
  const query = new URLSearchParams(search);
  const fragment = new URLSearchParams(hash.replace(/^#/, ""));
  const tokenHash = query.get("token_hash");
  if (tokenHash) {
    const type = query.get("type");
    return isLinkType(type) ? { kind: "otp", tokenHash, type } : "refused";
  }
  const accessToken = fragment.get("access_token");
  const refreshToken = fragment.get("refresh_token");
  if (accessToken || refreshToken) {
    const type = fragment.get("type");
    if (!accessToken || !refreshToken || !isLinkType(type)) return "refused";
    const claims = tokenClaims(accessToken);
    return {
      kind: "tokens", accessToken, refreshToken, type,
      userId: typeof claims.sub === "string" ? claims.sub : null,
      email: typeof claims.email === "string" ? claims.email : null,
    };
  }
  return null;
}

export type LinkDecision =
  /** Nobody else is signed in here (or it is the same person's link): use it. */
  | { action: "use" }
  /** Another account is signed in here: ask; continuing signs it out first. `linkFor` is null when the link doesn't say. */
  | { action: "confirm"; signedInAs: string; linkFor: string | null };

/** What to do with a link, given who (if anyone) is signed in in this browser now. */
export function linkDecision(link: SetPasswordLink, current: { id: string; email: string | null } | null): LinkDecision {
  if (!current) return { action: "use" };
  if (link.kind === "tokens" && link.userId !== null && link.userId === current.id) return { action: "use" };
  return { action: "confirm", signedInAs: current.email || "another account", linkFor: link.kind === "tokens" ? link.email : null };
}

/** How a reset or invite link shows in a session's amr: "recovery" / "invite" (a PKCE link), "otp" (verified link), "magiclink". */
const LINK_METHODS = new Set(["recovery", "invite", "otp", "magiclink"]);
/** How long after following the link the person may choose a password without their current one. */
export const LINK_SIGN_IN_MAX_AGE_S = 60 * 60;

/**
 * True when an e-mail link (a password reset or an invite) signed this session in within the last hour (`methods`: the session's
 * amr, as getAuthenticatorAssuranceLevel returns it): the link proved who it is, so choosing a new password needs no current one
 * (audit Z7/C9; the server's rule, app/api/auth/change-password). A session signed in with a password, an older link session, or
 * entries without a time do not count.
 */
export function recentLinkSignIn(methods: unknown, nowSeconds = Date.now() / 1000): boolean {
  if (!Array.isArray(methods)) return false;
  return methods.some((entry) => {
    const { method, timestamp } = (entry ?? {}) as { method?: unknown; timestamp?: unknown };
    return typeof method === "string" && LINK_METHODS.has(method) && typeof timestamp === "number"
      && timestamp <= nowSeconds + 60 && nowSeconds - timestamp <= LINK_SIGN_IN_MAX_AGE_S;
  });
}

/**
 * What the page shows once a session exists. The form only when the server will take a new password without the current one: a
 * link was just used, the person must replace a temporary password (?required=1), or a link signed this session in within the
 * hour. Anyone else signed in normally is pointed to Change password in Account Settings, which asks for the current password.
 */
export function setPasswordView(input: { linkUsed: boolean; required: boolean; methods: unknown; nowSeconds?: number }): "form" | "use-account-settings" {
  if (input.linkUsed || input.required || recentLinkSignIn(input.methods, input.nowSeconds)) return "form";
  return "use-account-settings";
}

/** True when the server refused a new password because an admin's session must pass the second step first (mfa_required). */
export function needsSecondStep(status: number | null | undefined, body: { code?: unknown } | null | undefined): boolean {
  return status === 403 && body?.code === "mfa_required";
}

/** The question shown for a "confirm" decision. */
export function confirmQuestion(decision: Extract<LinkDecision, { action: "confirm" }>): string {
  return decision.linkFor
    ? `You're signed in as ${decision.signedInAs}. Continue as ${decision.linkFor}?`
    : `You're signed in as ${decision.signedInAs}. This link may be for a different account. Continue with it?`;
}
