import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["tests/reviews/ai-independent/*.db.test.ts"],
  maxWorkers: 1, minWorkers: 1, testTimeout: 10000, hookTimeout: 60000 } });
