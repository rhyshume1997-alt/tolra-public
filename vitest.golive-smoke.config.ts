import path from "node:path";
import { defineConfig } from "vitest/config";

// The go-live smoke's SliQ part (tests/e2e/golive-smoke/sliq-import.vitest.ts): database only, on the disposable stack of
// .github/workflows/golive-smoke.yml (or a loopback database with the numbered migrations). Not part of `npm run test:db`.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname) } },
  test: {
    environment: "node",
    include: ["tests/e2e/golive-smoke/**/*.vitest.ts"],
    fileParallelism: false,
    sequence: { concurrent: false, shuffle: false },
    testTimeout: 120_000,
    hookTimeout: 120_000,
    ...(process.env.GOLIVE_SMOKE_VITEST_JSON ? { reporters: ["verbose", "json"], outputFile: { json: process.env.GOLIVE_SMOKE_VITEST_JSON } } : {}),
  },
});
