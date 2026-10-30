import path from "node:path";

/** Run state shared between playwright.config.ts, global setup and the specs (gitignored). */
export const E2E_STATE_DIR = path.resolve(__dirname, "../../test-results/e2e-state");
export const E2E_WORLD_FILE = path.join(E2E_STATE_DIR, "world.json");
export const E2E_BLOCKED_LOG = path.join(E2E_STATE_DIR, "blocked-network.log");
export const E2E_MOCK_PORT = Number(process.env.E2E_MOCK_PORT ?? 3999);
/** A second copy of the same build with REQUIRE_ADMIN_MFA=true, for tests/e2e/admin-mfa.spec.ts (the main server leaves it off). */
export const E2E_MFA_PORT = Number(process.env.E2E_MFA_PORT ?? (Number(process.env.E2E_PORT ?? 3001) + 1));
/** CRON_SECRET of the e2e app servers (playwright.config.ts) and the Bearer value tests/e2e/email-schedules.spec.ts sends to /api/cron/daily. A placeholder for the disposable stack only (16+ characters, or the route refuses every call). */
export const E2E_CRON_SECRET = "e2e-cron-secret-placeholder-not-real";
