import path from "node:path";
import { defineConfig } from "vitest/config";

// PQ environment suite. Deliberately its own config: it includes ONLY tests/pq/*.test.ts, so these tests never join the main
// (tests/unit) suite, the database suite (tests/db) or CI. Run with: npx vitest run -c tests/pq/vitest.config.ts
// The pg-only loader test additionally needs PQ_LOCAL_PG_URL (see tests/pq/README.md); without it that file's tests are skipped
// and say so.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "../..") } },
  test: {
    environment: "node",
    include: ["tests/pq/*.test.ts"],
    root: path.resolve(__dirname, "../.."),
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
