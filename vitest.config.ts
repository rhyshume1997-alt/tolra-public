import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname) } },
  // Components (PDF documents) use the automatic JSX runtime, as in the app.
  esbuild: { jsx: "automatic" },
  test: { environment: "node", include: ["tests/unit/**/*.test.ts"] },
});
