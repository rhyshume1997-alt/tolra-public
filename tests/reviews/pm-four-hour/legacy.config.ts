import path from "node:path";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@": path.resolve(process.cwd()) } },
  test: {
    environment: "node", include: ["tests/reviews/pm-four-hour/legacy-099.test.ts"],
    fileParallelism: false, testTimeout: 60_000, hookTimeout: 120_000,
  },
});
