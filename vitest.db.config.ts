import path from "node:path";
import { defineConfig } from "vitest/config";
import ReleaseSequencer from "./tests/support/db-release-sequencer";

// Database suite (audit B1): runs only against the local disposable Supabase (scripts/test-backend.sh).
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname) } },
  test: {
    environment: "node",
    include: ["tests/db/**/*.test.ts"],
    fileParallelism: false,
    sequence: { sequencer: ReleaseSequencer },
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // CI evidence only: the verbose lines stay in the step log and the JSON report is parsed by scripts/ci-evidence.mjs.
    ...(process.env.CI_EVIDENCE_DB_JSON ? { reporters: ["verbose", "json"], outputFile: { json: process.env.CI_EVIDENCE_DB_JSON } } : {}),
  },
});
