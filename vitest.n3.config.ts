import path from "node:path";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname) } },
  test: { environment: "node", include: ["tests/db/n3-sliq-preprocess.test.ts"], fileParallelism: false,
    testTimeout: 60_000, hookTimeout: 120_000, reporters: ["default", "json"], outputFile: "work/n3/results.json" },
});
