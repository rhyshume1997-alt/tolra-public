/**
 * How sign-in failures are classified for DISPLAY (lib/auth-errors.ts): an unreachable or failing server is "can't reach",
 * wrong credentials stay "invalid", and a rate limit keeps its own message. Nothing here changes who can sign in.
 */
import { describe, expect, it } from "vitest";

import { UNREACHABLE_MESSAGE, classifySignInResponse, confirmLocalSignOut, isUnreachableError } from "@/lib/auth-errors";

describe("classifySignInResponse", () => {
  it("treats a failed fetch (no response) as unreachable", () => {
    expect(classifySignInResponse(null)).toEqual({ kind: "unreachable" });
    expect(classifySignInResponse(0)).toEqual({ kind: "unreachable" });
  });
  it("treats 5xx, including 503, as unreachable", () => {
    for (const status of [500, 502, 503, 504]) expect(classifySignInResponse(status, "Sign-in is temporarily unavailable.")).toEqual({ kind: "unreachable" });
  });
  it("keeps 401 and other client errors as invalid credentials", () => {
    for (const status of [400, 401, 403]) expect(classifySignInResponse(status, "Invalid username or password")).toEqual({ kind: "invalid" });
  });
  it("keeps the server's too-many message on 429, with a fallback", () => {
    expect(classifySignInResponse(429, "Too many sign-in attempts. Wait a few minutes and try again.")).toEqual({ kind: "too_many", message: "Too many sign-in attempts. Wait a few minutes and try again." });
    expect(classifySignInResponse(429)).toEqual({ kind: "too_many", message: "Too many attempts." });
  });
  it("names the product in the unreachable message", () => {
    expect(UNREACHABLE_MESSAGE).toBe("Can't reach Tolra right now. Check your connection and try again.");
  });
});

describe("isUnreachableError", () => {
  it("recognises thrown fetches, auth-js retryable errors and 5xx / status 0", () => {
    expect(isUnreachableError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isUnreachableError({ name: "AuthRetryableFetchError", message: "x", status: 0 })).toBe(true);
    expect(isUnreachableError({ message: "x", status: 502 })).toBe(true);
    expect(isUnreachableError({ message: "NetworkError when attempting to fetch resource." })).toBe(true);
  });
  it("does not treat wrong credentials, missing rows or empty values as unreachable", () => {
    expect(isUnreachableError({ name: "AuthApiError", message: "Invalid login credentials", status: 400 })).toBe(false);
    expect(isUnreachableError({ code: "PGRST116", message: "no rows" })).toBe(false);
    expect(isUnreachableError(null)).toBe(false);
    expect(isUnreachableError(undefined)).toBe(false);
  });
});

describe("confirmLocalSignOut", () => {
  const session = { access_token: "t" };
  const client = (over: Partial<Parameters<typeof confirmLocalSignOut>[0]>) => ({
    signOut: async () => ({ error: null }),
    getSession: async () => ({ data: { session: null }, error: null }),
    ...over,
  });
  it("is true when the local sign-out succeeded", async () => {
    expect(await confirmLocalSignOut(client({}))).toBe(true);
  });
  it("is true when sign-out failed but no session remains", async () => {
    expect(await confirmLocalSignOut(client({ signOut: async () => { throw new TypeError("Failed to fetch"); } }))).toBe(true);
    expect(await confirmLocalSignOut(client({ signOut: async () => ({ error: new Error("x") }) }))).toBe(true);
  });
  it("is false when sign-out failed (network failure) and a session is still held", async () => {
    const failing = async () => { throw new TypeError("Failed to fetch"); };
    expect(await confirmLocalSignOut(client({ signOut: failing, getSession: async () => ({ data: { session }, error: null }) }))).toBe(false);
    expect(await confirmLocalSignOut(client({ signOut: async () => ({ error: new Error("x") }), getSession: async () => ({ data: { session }, error: null }) }))).toBe(false);
  });
  it("is false when the session can't be checked either", async () => {
    expect(await confirmLocalSignOut(client({ signOut: async () => ({ error: new Error("x") }), getSession: async () => { throw new Error("boom"); } }))).toBe(false);
    expect(await confirmLocalSignOut(client({ signOut: async () => ({ error: new Error("x") }), getSession: async () => ({ data: { session: null }, error: new Error("y") }) }))).toBe(false);
  });
});
