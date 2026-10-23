import path from "node:path";
import { defineConfig } from "vitest/config";

// Live Microsoft 365 suite (docs/M365-MAIL.md): TEST tenant only, needs the local Supabase (scripts/test-backend.sh) and
// the MS_TEST_* settings. Not included by vitest.config.ts (unit) or vitest.db.config.ts; run with `npm run test:live`.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname) } },
  test: {
    environment: "node",
    include: ["tests/live/**/*.live.test.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
