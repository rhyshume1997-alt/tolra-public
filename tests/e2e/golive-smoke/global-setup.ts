/**
 * Go-live smoke global setup: the browser suite's own setup (tests/e2e/global-setup.ts, unchanged: isolation guard, synthetic world,
 * mock e-mail provider, the chase browser fixture, the check that the app talks to this backend), plus the stand-in costing engine.
 * The smoke company itself was made before the post-144 releases (scripts/golive-smoke/seed-company.mjs) and is read from its file.
 */
import { existsSync } from "node:fs";

import type { FullConfig } from "@playwright/test";

import baseGlobalSetup from "../global-setup";
import { COSTING_PORT, startMockCosting } from "./mock-costing";
import { TENANT_FILE } from "./results";

export default async function globalSetup(config: FullConfig) {
  if (!existsSync(TENANT_FILE)) throw new Error(`${TENANT_FILE} not found: run scripts/golive-smoke/seed-company.mjs before the releases (see .github/workflows/golive-smoke.yml)`);
  const costing = await startMockCosting(COSTING_PORT);
  let teardown: (() => Promise<void>) | undefined;
  try {
    teardown = (await baseGlobalSetup(config)) as (() => Promise<void>) | undefined;
  } catch (error) {
    await costing.close();
    throw error;
  }
  return async () => {
    try { if (teardown) await teardown(); } finally { await costing.close(); }
  };
}
