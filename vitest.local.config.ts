import path from "node:path";
import { defineConfig } from "vitest/config";

// Hand-run proofs that need whole-database copies on a LOCAL Postgres (tests/local): never part of CI (see each file's header).
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname) } },
  test: { environment: "node", include: ["tests/local/**/*.test.ts"], fileParallelism: false, testTimeout: 120_000, hookTimeout: 300_000 },
});
