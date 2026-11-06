import path from "node:path";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
export default defineConfig({ ...base, testMatch: "preliminary.spec.ts", timeout: 240_000,
  outputDir: path.join(__dirname, "results/preliminary-browser") });
