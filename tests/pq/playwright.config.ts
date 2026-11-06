import path from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: __dirname,
  testMatch: "screenshots.spec.ts",
  outputDir: path.join(__dirname, "results"),
  workers: 1, retries: 0, forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  use: { baseURL: "http://localhost:3007", browserName: "chromium", headless: true, viewport: { width: 1440, height: 1000 }, screenshot: "only-on-failure" },
  webServer: { command: "node tests/pq/pq.mjs serve", cwd: path.resolve(__dirname, "../.."), url: "http://127.0.0.1:3007/login", reuseExistingServer: false, timeout: 300_000 },
});
