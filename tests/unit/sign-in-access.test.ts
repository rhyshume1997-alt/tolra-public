import { describe, expect, it } from "vitest";

import { disableSignInConfirm, identityActions, parseProtectedList, parseSignInList, PROTECTED_CHECK_REASON, PROTECTED_ROW_REASON, SIGN_IN_CHECKING_LABEL, SIGN_IN_HELP, signInBadge } from "@/lib/sign-in-access";

describe("Disable sign-in wording and the list the page reads", () => {
  it("reads only well-formed rows", () => {
    const map = parseSignInList({ users: [{ user_id: "a", sign_in: "on" }, { user_id: "b", sign_in: "off" }, { user_id: "c", sign_in: "off_platform" }, { user_id: "d", sign_in: "maybe" }, { sign_in: "on" }, null] });
    expect([...map.entries()]).toEqual([["a", "on"], ["b", "off"], ["c", "off_platform"]]);
    expect(parseSignInList(null).size).toBe(0);
    expect(parseSignInList({ users: "x" }).size).toBe(0);
  });

  it("says what happens and when to use it", () => {
    const text = disableSignInConfirm("Sam", "JNR Engineering");
    expect(text).toContain("Use this when someone leaves");
    expect(text).toContain("stops them signing in to Tolra");
    expect(text).toContain("Enable sign-in undoes it");
    expect(SIGN_IN_HELP).toContain("Leaver");
    expect(SIGN_IN_HELP).toContain("Deactivate can't remove someone's only company");
  });

  it("badges only a disabled sign-in, naming who disabled it", () => {
    expect(signInBadge("on")).toBeNull();
    expect(signInBadge(undefined)).toBeNull();
    expect(signInBadge("unknown")).toBeNull();
    expect(signInBadge("off")).toBe("Sign-in disabled");
    expect(signInBadge("off_platform")).toBe("Sign-in disabled by Tolra");
  });
});

describe("093: a platform owner / support login gets no identity actions", () => {
  it("reads the GET's protected list; anything malformed is dropped", () => {
    const map = parseProtectedList({ users: [], protected: [{ user_id: "a", state: "protected" }, { user_id: "b", state: "check_unavailable" }, { user_id: "c", state: "x" }, { state: "protected" }, null] });
    expect([...map]).toEqual([["a", "protected"], ["b", "check_unavailable"]]);
    expect(parseProtectedList(null).size).toBe(0);
  });
  it("protected: off with the platform-owner reason; check unavailable or the answer unreadable: off with the 093 reason", () => {
    expect(identityActions({ isSelf: false, checking: false, unavailable: false, state: "protected" })).toEqual({ allowed: false, reason: PROTECTED_ROW_REASON });
    expect(PROTECTED_ROW_REASON).toBe("Platform owner / support login: managed by the platform owner.");
    expect(identityActions({ isSelf: false, checking: false, unavailable: false, state: "check_unavailable" })).toEqual({ allowed: false, reason: PROTECTED_CHECK_REASON });
    expect(identityActions({ isSelf: false, checking: false, unavailable: true, state: undefined })).toEqual({ allowed: false, reason: PROTECTED_CHECK_REASON });
    expect(PROTECTED_CHECK_REASON).toContain("needs its 093 update");
  });
  it("while the answer is on its way nothing is offered; an ordinary member and oneself get the actions", () => {
    expect(identityActions({ isSelf: false, checking: true, unavailable: false, state: undefined })).toEqual({ allowed: false, reason: SIGN_IN_CHECKING_LABEL });
    expect(identityActions({ isSelf: false, checking: false, unavailable: false, state: undefined })).toEqual({ allowed: true, reason: null });
    expect(identityActions({ isSelf: true, checking: false, unavailable: true, state: "protected" })).toEqual({ allowed: true, reason: null });
  });
});
