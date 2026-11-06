/**
 * sm-b (1): can turning REQUIRE_ADMIN_MFA on lock an admin out with no way through? The matrix below walks every combination of
 * env switch x holds admin x assurance level, using the same functions the middleware and requireProfile use, and checks that every
 * admin the gate sends to /mfa can still reach an enrolment step there.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { adminMfaRequired, holdsAdmin, shouldCheckEnrolment } from "@/lib/mfa-policy";

const read = (p: string) => readFileSync(p, "utf8");

/** The decision middleware.ts / lib/server/auth.ts make for a signed-in person on a page other than /mfa. */
function gate(env: string | undefined, role: string, level: "aal1" | "aal2") {
  const required = adminMfaRequired({ REQUIRE_ADMIN_MFA: env });
  return required && holdsAdmin({ role }) && level !== "aal2" ? "to-mfa" : "pass";
}

describe("sm-b: REQUIRE_ADMIN_MFA x admin x aal matrix", () => {
  const envs: [string | undefined, boolean][] = [["true", true], ["1", true], ["on", true], [" TRUE ", true], ["false", false], ["0", false], ["off", false], [undefined, false], ["", false], ["yes", false]];
  it.each(envs)("env %j switches the gate %s", (env, on) => {
    expect(adminMfaRequired({ REQUIRE_ADMIN_MFA: env })).toBe(on);
  });

  it("only an admin below aal2 with the env on is sent to /mfa; everyone else passes", () => {
    for (const [env, on] of envs) for (const role of ["admin", "manager", "operator"]) for (const level of ["aal1", "aal2"] as const) {
      const expected = on && role === "admin" && level === "aal1" ? "to-mfa" : "pass";
      expect(gate(env, role, level), `${env}/${role}/${level}`).toBe(expected);
    }
  });

  it("the enrolment check never runs when the env is on (the aal2 gate owns it) or for non-admins, and runs for admins below aal2 otherwise", () => {
    expect(shouldCheckEnrolment({ globalRequired: true, holdsAdmin: true, currentLevel: "aal1", nextLevel: "aal1" })).toBe(false);
    expect(shouldCheckEnrolment({ globalRequired: false, holdsAdmin: false, currentLevel: "aal1", nextLevel: "aal1" })).toBe(false);
    expect(shouldCheckEnrolment({ globalRequired: false, holdsAdmin: true, currentLevel: "aal1", nextLevel: "aal1" })).toBe(true);
    expect(shouldCheckEnrolment({ globalRequired: false, holdsAdmin: true, currentLevel: "aal1", nextLevel: "aal2" })).toBe(false);
    expect(shouldCheckEnrolment({ globalRequired: false, holdsAdmin: true, currentLevel: "aal2", nextLevel: "aal2" })).toBe(false);
  });

  it("an UNENROLLED admin with the env on (aal1, nextLevel aal1) is sent to /mfa, and /mfa is the one page the gate lets through", () => {
    expect(gate("true", "admin", "aal1")).toBe("to-mfa");
    const mw = read("middleware.ts");
    expect(mw).toMatch(/assurance\?\.currentLevel !== "aal2"\) return path === "\/mfa" \? response : redirectTo\("\/mfa"\)/);
  });

  it("/mfa offers enrolment (not a dead end) to a person with no verified factor, and a code step to one who has it", () => {
    const page = read("app/mfa/page.tsx");
    expect(page).toContain("supabase.auth.mfa.enroll(");
    expect(page).toMatch(/const verified = factors\?\.totp\?\.\[0\];[\s\S]*?else \{\s*await startEnrolment\(\);/);
    expect(page).toContain("challengeAndVerify");
  });

  it("the API answers 403 mfa_required (not a hang or 401) so the browser can send the person to /mfa", () => {
    const auth = read("lib/server/auth.ts");
    expect(auth).toMatch(/assuranceError \|\| assurance\?\.currentLevel !== "aal2"\) return mfaRequired\(\)/);
  });
});
