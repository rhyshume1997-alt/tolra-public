import path from "node:path";
import { defineConfig } from "vitest/config";

// Upgrade rehearsal (audit B10, SEC13): run only through scripts/upgrade-rehearsal.sh, which first rebuilds the
// LOCAL disposable database at an older migration. Never part of the normal suites.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname) } },
  test: {
    environment: "node",
    include: ["tests/rehearsal/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
