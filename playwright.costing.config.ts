import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
import { optionalBackendConfigured } from "./tests/support/optional-backend";
const available = optionalBackendConfigured();
export default defineConfig({ ...base, testMatch: /costing-smoke\.spec\.ts/, globalSetup: available ? base.globalSetup : undefined, webServer: available ? base.webServer : undefined });
