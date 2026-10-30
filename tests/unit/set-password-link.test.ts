/**
 * Audit C3: the set-password page used any token_hash type (invite, recovery, signup, magiclink, email) or any access/refresh token
 * pair in the URL to replace the browser's session, so a link someone else sent could swap a signed-in person into another account.
 * Now only invite and recovery links are read, and another account already signed in is asked about, never swapped silently.
 */
import { describe, expect, it } from "vitest";

import { confirmQuestion, linkDecision, readSetPasswordLink } from "@/lib/set-password-link";

const jwt = (claims: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const ALICE = { id: "11111111-1111-4111-8111-111111111111", email: "alice@example.test" };
const MALLORY = { sub: "99999999-9999-4999-8999-999999999999", email: "mallory@example.test" };
const tokens = (claims: Record<string, unknown>, type = "recovery") => `#access_token=${jwt(claims)}&refresh_token=r1&token_type=bearer&type=${type}`;

describe("readSetPasswordLink: only invite and password-reset links", () => {
  it("token_hash links: invite and recovery are read; signup, magiclink, email and anything else are refused", () => {
    expect(readSetPasswordLink("?token_hash=abc&type=recovery", "")).toEqual({ kind: "otp", tokenHash: "abc", type: "recovery" });
    expect(readSetPasswordLink("?token_hash=abc&type=invite", "")).toEqual({ kind: "otp", tokenHash: "abc", type: "invite" });
    for (const type of ["signup", "magiclink", "email", "email_change", "", "RECOVERY"]) {
      expect(readSetPasswordLink(`?token_hash=abc&type=${type}`, ""), type).toBe("refused");
    }
    expect(readSetPasswordLink("?token_hash=abc", "")).toBe("refused");
  });

  it("token links: invite and recovery only, both tokens needed; whose link it is is read from the token", () => {
    expect(readSetPasswordLink("", tokens(MALLORY))).toMatchObject({ kind: "tokens", type: "recovery", refreshToken: "r1", userId: MALLORY.sub, email: MALLORY.email });
    expect(readSetPasswordLink("", tokens(MALLORY, "invite"))).toMatchObject({ kind: "tokens", type: "invite" });
    expect(readSetPasswordLink("", tokens(MALLORY, "magiclink"))).toBe("refused");
    expect(readSetPasswordLink("", tokens(MALLORY, "signup"))).toBe("refused");
    expect(readSetPasswordLink("", `#access_token=${jwt(MALLORY)}&refresh_token=r1`)).toBe("refused");
    expect(readSetPasswordLink("", `#access_token=${jwt(MALLORY)}&type=recovery`)).toBe("refused");
    expect(readSetPasswordLink("", "#refresh_token=r1&type=recovery")).toBe("refused");
  });

  it("a token that can't be read still counts as a link, just with nobody named", () => {
    expect(readSetPasswordLink("", "#access_token=not-a-jwt&refresh_token=r1&type=recovery")).toMatchObject({ kind: "tokens", userId: null, email: null });
  });

  it("no link: ?required=1, ?code= (supabase-js's own exchange) or nothing", () => {
    expect(readSetPasswordLink("?required=1", "")).toBeNull();
    expect(readSetPasswordLink("?code=xyz", "")).toBeNull();
    expect(readSetPasswordLink("", "")).toBeNull();
  });
});

describe("linkDecision: never a silent swap", () => {
  const malloryLink = readSetPasswordLink("", tokens(MALLORY));
  const otpLink = readSetPasswordLink("?token_hash=abc&type=recovery", "");
  if (malloryLink === "refused" || !malloryLink || otpLink === "refused" || !otpLink) throw new Error("fixture");

  it("nobody signed in here: use the link", () => {
    expect(linkDecision(malloryLink, null)).toEqual({ action: "use" });
    expect(linkDecision(otpLink, null)).toEqual({ action: "use" });
  });

  it("someone else signed in: ask, naming both when the link says whose it is", () => {
    const decision = linkDecision(malloryLink, ALICE);
    expect(decision).toEqual({ action: "confirm", signedInAs: ALICE.email, linkFor: MALLORY.email });
    if (decision.action !== "confirm") throw new Error("expected confirm");
    expect(confirmQuestion(decision)).toBe("You're signed in as alice@example.test. Continue as mallory@example.test?");
  });

  it("a token_hash link can't say whose it is before it is used: anyone signed in is asked", () => {
    const decision = linkDecision(otpLink, ALICE);
    expect(decision).toEqual({ action: "confirm", signedInAs: ALICE.email, linkFor: null });
    if (decision.action !== "confirm") throw new Error("expected confirm");
    expect(confirmQuestion(decision)).toBe("You're signed in as alice@example.test. This link may be for a different account. Continue with it?");
  });

  it("the signed-in person's own token link is used without asking", () => {
    const own = readSetPasswordLink("", tokens({ sub: ALICE.id, email: ALICE.email }));
    if (own === "refused" || !own) throw new Error("fixture");
    expect(linkDecision(own, ALICE)).toEqual({ action: "use" });
  });

  it("a token naming nobody is not taken for the signed-in person's", () => {
    const anonymous = readSetPasswordLink("", "#access_token=not-a-jwt&refresh_token=r1&type=recovery");
    if (anonymous === "refused" || !anonymous) throw new Error("fixture");
    expect(linkDecision(anonymous, ALICE)).toMatchObject({ action: "confirm", linkFor: null });
    expect(linkDecision(malloryLink, { id: "x", email: null })).toMatchObject({ action: "confirm", signedInAs: "another account" });
  });
});
