import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "../..") } },
  test: { environment: "node", include: ["tests/pq/seed.test.ts"], testTimeout: 180_000, hookTimeout: 180_000, fileParallelism: false },
});
