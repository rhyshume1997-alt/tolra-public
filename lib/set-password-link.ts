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

/** The question shown for a "confirm" decision. */
export function confirmQuestion(decision: Extract<LinkDecision, { action: "confirm" }>): string {
  return decision.linkFor
    ? `You're signed in as ${decision.signedInAs}. Continue as ${decision.linkFor}?`
    : `You're signed in as ${decision.signedInAs}. This link may be for a different account. Continue with it?`;
}
