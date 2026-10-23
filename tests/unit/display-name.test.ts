import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { countMissingNames, DISPLAY_NAME_MAX, displayNameProblem, hasDisplayName, normaliseDisplayName, shouldPromptForName } from "@/lib/display-name";
import { cleanName } from "@/lib/people";

describe("display names", () => {
  it("follows company_people's rule: not empty, no e-mail address", () => {
    for (const value of [null, undefined, "", "   ", "dave@example.test"]) {
      expect(hasDisplayName(value)).toBe(false);
      expect(cleanName(value)).toBeNull();
    }
    expect(hasDisplayName(" Dave Smith ")).toBe(true);
    expect(cleanName(" Dave Smith ")).toBe("Dave Smith");
  });
  it("explains why a typed name can't be saved", () => {
    expect(displayNameProblem("  ")).toBe("Enter your name.");
    expect(displayNameProblem("me@work.test")).toBe("Use a name, not an email address.");
    expect(displayNameProblem("x".repeat(DISPLAY_NAME_MAX + 1))).toMatch(/80 characters/);
    expect(displayNameProblem("Dave")).toBeNull();
    expect(normaliseDisplayName("  Dave   Smith ")).toBe("Dave Smith");
  });
  it("prompts only a person with no name, never a support session", () => {
    expect(shouldPromptForName({ fullName: null })).toBe(true);
    expect(shouldPromptForName({ fullName: "ops@tolra.test" })).toBe(true);
    expect(shouldPromptForName({ fullName: "Dave" })).toBe(false);
    expect(shouldPromptForName({ fullName: null, support: true })).toBe(false);
  });
  it("counts the staff with no name, support logins aside", () => {
    expect(countMissingNames([{ fullName: "Dave" }, { fullName: "" }, { fullName: "a@b.test" }, { fullName: null, support: true }])).toBe(2);
  });
  it("the admin API renames with the caller's client (RLS), never the service role, and refuses a shared login", () => {
    const route = readFileSync(path.join(__dirname, "../../app/api/admin/users/route.ts"), "utf8");
    const block = route.slice(route.indexOf("let savedName"), route.lastIndexOf("const { data: current }"));
    expect(block).toContain("auth.supabase.from(\"user_profiles\").update({ full_name: name })");
    expect(block).not.toMatch(/admin\.from\("user_profiles"\)\.update/);
    expect(route).toContain("full_name !== undefined && user_id !== auth.user.id && !(await ownsIdentity(");
  });
});
