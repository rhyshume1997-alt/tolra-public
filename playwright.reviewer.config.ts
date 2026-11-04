import { randomBytes } from "node:crypto";
import { defineConfig } from "@playwright/test";
import base from "./playwright.n1-n6.config";
import { browserDatabaseConfigured, requireBrowserDatabase } from "./tests/support/optional-browser-database";
const configured = browserDatabaseConfigured();
requireBrowserDatabase(configured, process.env.REVIEWER_REQUIRE_DATABASE === "1");
// Synthetic, per-run encryption key shared only with the local test processes; never committed or printed.
process.env.REVIEWER_TEST_KEY ??= randomBytes(32).toString("base64");
const servers = base.webServer ? (Array.isArray(base.webServer) ? base.webServer : [base.webServer]) : [];
export default defineConfig({
  ...base,
  testMatch: /reviewer\/.*\.spec\.ts/,
  testIgnore: [],
  webServer: configured ? servers.map(server => ({ ...server, env: { ...server.env,
    INTEGRATIONS_ENCRYPTION_KEY: process.env.REVIEWER_TEST_KEY!, REVIEWER_LOCAL_MOCKS: "1",
    NODE_OPTIONS: `${server.env?.NODE_OPTIONS ?? ""} --require ./tests/support/reviewer-provider-mocks.cjs`,
    SAGE_CLIENT_ID: "reviewer-fake-id", SAGE_CLIENT_SECRET: "reviewer-fake-secret", SAGE_REDIRECT_URI: `${server.env?.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001"}/api/accounting/sage/callback`,
    QUICKBOOKS_CLIENT_ID: "reviewer-fake-id", QUICKBOOKS_CLIENT_SECRET: "reviewer-fake-secret", QUICKBOOKS_REDIRECT_URI: `${server.env?.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001"}/api/accounting/quickbooks/callback`,
  } })) : undefined,
});
