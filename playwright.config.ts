import { randomBytes } from "node:crypto";

import { defineConfig } from "@playwright/test";

import { E2E_BLOCKED_LOG, E2E_MFA_PORT, E2E_MOCK_PORT } from "./tests/e2e/paths";
import { assertLoopbackUrl, isolatedBackend } from "./tests/support/isolation";

/**
 * Browser suite (audit B1). Runs only against the local disposable Supabase (`npm run test:backend`):
 *
 * - The app server is always started here, with the test backend's keys, a mock e-mail provider and an outbound
 *   network guard. An already running server is never reused, so a stray `next dev` pointed at production can't be
 *   picked up. E2E_BASE_URL (loopback only, never in CI) is for debugging against a server you started yourself;
 *   global setup still proves that server talks to the test backend.
 * - Without an isolated backend the run fails in global setup (no skipped tests). Listing tests (`--list`) needs
 *   no backend or credentials.
 * - The server serves a production build made against the test backend (NEXT_PUBLIC_* values are baked in at build
 *   time): set E2E_SKIP_BUILD=1 when the build already exists (CI builds it in an earlier step).
 */
const port = Number(process.env.E2E_PORT ?? 3001);
const external = process.env.E2E_BASE_URL;
if (external && process.env.CI) throw new Error("E2E_BASE_URL is not allowed in CI: the suite must start its own server");
// "localhost", not 127.0.0.1: `next start` builds its redirect URLs with localhost, and a host change would drop
// the session cookie mid-test.
const baseURL = external ? assertLoopbackUrl("E2E_BASE_URL", external) : `http://localhost:${port}`;

function serverEnv(): Record<string, string> | null {
  let backend;
  try {
    backend = isolatedBackend();
  } catch {
    return null; // global setup reports the isolation error; nothing is started.
  }
  return {
    NEXT_PUBLIC_SUPABASE_URL: backend.apiUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: backend.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: backend.serviceRoleKey,
    NEXT_PUBLIC_SITE_URL: baseURL,
    NEXT_TELEMETRY_DISABLED: "1",
    RESEND_API_KEY: "re_test_mock",
    RESEND_BASE_URL: `http://127.0.0.1:${E2E_MOCK_PORT}`,
    EMAIL_FROM: "Tolra Test <noreply@example.test>",
    COSTING_ENGINE_URL: "",
    COSTING_ENGINE_TOKEN: "",
    TENANT_ROOT_DOMAIN: "",
    NODE_OPTIONS: "--require ./tests/support/no-network.cjs",
    E2E_BLOCKED_LOG,
    // The AI admin helper: on for this server, with the deterministic mock provider (no model, no network). Each company's own
    // switches still start off. The encryption key for the company API keys is made fresh for each run (a test value, never stored).
    AI_HELPER_ENABLED: "true",
    AI_HELPER_PROVIDER: "mock",
    INTEGRATIONS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  };
}

const env = external ? null : serverEnv();
const build = process.env.E2E_SKIP_BUILD === "1" ? "" : "npm run build && ";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts/,
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"]],
  use: {
    baseURL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    ...(process.env.E2E_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.E2E_CHROMIUM_PATH } } : {}),
  },
  webServer: env
    ? [
        {
          command: `${build}npx next start -H 127.0.0.1 -p ${port}`,
          url: `http://127.0.0.1:${port}/login`,
          reuseExistingServer: false,
          timeout: 300_000,
          env: { ...env, REQUIRE_ADMIN_MFA: "false" },
        },
        // The same build with the admin second step required (tests/e2e/admin-mfa.spec.ts). Starts after the build above.
        {
          command: `npx next start -H 127.0.0.1 -p ${E2E_MFA_PORT}`,
          url: `http://127.0.0.1:${E2E_MFA_PORT}/login`,
          reuseExistingServer: false,
          timeout: 300_000,
          env: { ...env, REQUIRE_ADMIN_MFA: "true", NEXT_PUBLIC_SITE_URL: `http://localhost:${E2E_MFA_PORT}` },
        },
      ]
    : undefined,
});
