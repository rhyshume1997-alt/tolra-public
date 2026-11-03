import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
import { optionalBackendConfigured } from "./tests/support/optional-backend";
const available = optionalBackendConfigured();
// The main runner stays strict. This opt-in runner can report an absent local backend as skipped.
export default defineConfig({ ...base, testMatch: /(?:chase-steps|chasing-controls)\.spec\.ts/, globalSetup: available ? base.globalSetup : undefined, webServer: available ? base.webServer : undefined });
