import { expect, it } from "vitest";
import { adminMfaRequired, recentSecondStep, shouldCheckEnrolment, changesAdmin } from "@/lib/mfa-policy";

it.each([null, [], [{ method: "password", timestamp: 1000 }], [{ method: "totp" }], [{ method: "totp", timestamp: 1 }], [{ method: "totp", timestamp: 2000 }]])("malformed/stale/far-future MFA is not a recent second step: %j", methods => {
  expect(recentSecondStep(methods, 1000)).toBe(false);
});
it("departed administrator deactivation is an admin-rights change", () => {
  expect(changesAdmin({ role: "admin", active: true }, { active: false })).toBe(true);
  expect(changesAdmin({ role: "office", secondary_role: "admin", active: true }, { active: false })).toBe(true);
});
it("enrolment is checked for new admins even when global enforcement is off", () => {
  expect(shouldCheckEnrolment({ globalRequired: false, holdsAdmin: true, currentLevel: "aal1", nextLevel: "aal1" })).toBe(true);
  expect(shouldCheckEnrolment({ globalRequired: false, holdsAdmin: false, currentLevel: "aal1", nextLevel: "aal1" })).toBe(false);
});
it("production MFA is a separate explicit setting, not proof from enrolment", () => {
  expect(adminMfaRequired({ REQUIRE_ADMIN_MFA: "true" })).toBe(true);
  expect(adminMfaRequired({})).toBe(false);
});
