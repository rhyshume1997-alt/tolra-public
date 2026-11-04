import path from "node:path";

import { defineConfig } from "@playwright/test";

import base from "./playwright.config";
import { COSTING_PORT, COSTING_TOKEN } from "./tests/e2e/golive-smoke/mock-costing";

/**
 * The go-live smoke walk (tests/e2e/golive-smoke/walk.smoke.ts), run once by .github/workflows/golive-smoke.yml on its disposable stack.
 * The browser suite's config (playwright.config.ts, unchanged) with: only the smoke walk (its file is *.smoke.ts, so the ordinary suite
 * never collects it), the smoke global setup (the suite's own, plus a stand-in costing engine on loopback), the first app server only
 * (the walk needs no second-step server) with COSTING_ENGINE_URL / COSTING_ENGINE_TOKEN pointing at that stand-in, and a JSON report
 * for the gate. `npx playwright test -c playwright.golive-smoke.config.ts --list` needs no backend.
 */
const SMOKE_DIR = process.env.GOLIVE_SMOKE_DIR ?? path.resolve(__dirname, "work/golive-smoke");
const servers = base.webServer ? (Array.isArray(base.webServer) ? base.webServer : [base.webServer]) : [];

export default defineConfig({
  ...base,
  testMatch: /golive-smoke\/walk\.smoke\.ts$/,
  testIgnore: [],
  globalSetup: "./tests/e2e/golive-smoke/global-setup.ts",
  timeout: 40 * 60_000,
  reporter: [["list"], ["json", { outputFile: path.join(SMOKE_DIR, "playwright.json") }]],
  webServer: servers.length
    ? [{ ...servers[0], env: { ...(servers[0].env ?? {}), COSTING_ENGINE_URL: `http://127.0.0.1:${COSTING_PORT}`, COSTING_ENGINE_TOKEN: COSTING_TOKEN } }]
    : undefined,
});
