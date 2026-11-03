import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
      // next/font only works through Next's compiler; the public pages' fonts (components/marketing/fonts.ts, next/font/local) get a stub here.
      "next/font/google": path.resolve(__dirname, "tests/stubs/next-font-google.ts"),
      "next/font/local": path.resolve(__dirname, "tests/stubs/next-font-local.ts"),
    },
  },
  // Components (PDF documents) use the automatic JSX runtime, as in the app.
  esbuild: { jsx: "automatic" },
  test: { environment: "node", include: ["tests/unit/**/*.test.ts"] },
});
