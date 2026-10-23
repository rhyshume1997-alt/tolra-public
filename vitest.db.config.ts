import path from "node:path";
import { defineConfig } from "vitest/config";

// Database suite (audit B1): runs only against the local disposable Supabase (scripts/test-backend.sh).
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname) } },
  test: {
    environment: "node",
    include: ["tests/db/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
