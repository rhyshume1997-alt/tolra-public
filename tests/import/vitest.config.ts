import path from "node:path";
import { defineConfig } from "vitest/config";

// SliQ import rehearsal (tests/import). Its own config on purpose: the main suite (vitest.config.ts) and the database suite
// (vitest.db.config.ts) never pick these up, and these never need the Docker/Supabase backend. They need only the disposable
// PostgreSQL described in tests/import/README.md.  Run:  npx vitest run --config tests/import/vitest.config.ts
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "../..") } },
  test: {
    environment: "node",
    include: ["tests/import/*.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 240_000,
  },
});
