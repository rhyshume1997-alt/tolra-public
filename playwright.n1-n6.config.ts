import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
import { browserDatabaseConfigured, requireBrowserDatabase } from "./tests/support/optional-browser-database";
import { isolatedBackend } from "./tests/support/isolation";

// This opt-in runner alone may skip when no backend was supplied. The existing
// playwright.config.ts and its fail-closed global setup are unchanged.
const configured = browserDatabaseConfigured();
requireBrowserDatabase(configured);
if (configured) isolatedBackend(); // reject partial, hosted or otherwise unsafe settings

export default defineConfig({
  ...base,
  testMatch: /n1-n6\/.*\.spec\.ts/,
  globalSetup: configured ? base.globalSetup : undefined,
  webServer: configured ? base.webServer : undefined,
});
