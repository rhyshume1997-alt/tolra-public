import { expect, it } from "vitest";
import { browserDatabaseConfigured, requireBrowserDatabase, NO_BROWSER_DATABASE } from "../support/optional-browser-database";

it("allows a clear skip only when no test database was supplied", () => {
  expect(browserDatabaseConfigured({}, false)).toBe(false);
  expect(() => requireBrowserDatabase(false, false)).not.toThrow();
});
it.each(["TEST_SUPABASE_URL", "TEST_SUPABASE_ANON_KEY", "TEST_SUPABASE_SERVICE_ROLE_KEY", "TEST_DATABASE_URL"])("does not hide partial configuration: %s", name => {
  expect(browserDatabaseConfigured({[name]:"configured"}, false)).toBe(true);
});
it("does not treat an existing env file as absence", () => {
  expect(browserDatabaseConfigured({}, true)).toBe(true);
});
it("fails instead of skipping when CI requires the database", () => {
  expect(() => requireBrowserDatabase(false, true)).toThrow(NO_BROWSER_DATABASE);
  expect(() => requireBrowserDatabase(true, true)).not.toThrow();
});
