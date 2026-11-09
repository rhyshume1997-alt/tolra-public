import path from "node:path";
import { defineConfig } from "vitest/config";

const source = path.resolve(process.env.AI_CONTRACT_SOURCE_ROOT ?? ".");
export default defineConfig({
  resolve: { alias: [
    { find: "server-only", replacement: path.resolve("tests/reviews/ai-independent/server-only.ts") },
    ...(process.env.AI_CONTRACT_SERVER_FILE ? [{ find: "@/lib/ai-helper/server", replacement: path.resolve(process.env.AI_CONTRACT_SERVER_FILE) }] : []),
    ...(process.env.AI_CONTRACT_CONTEXT_FILE ? [{ find: "@/lib/ai-helper/tolra-key-context", replacement: path.resolve(process.env.AI_CONTRACT_CONTEXT_FILE) }] : []),
    { find: "@", replacement: source },
  ] },
  test: { environment: "node", include: ["tests/reviews/ai-independent/*.unit.test.ts"], maxWorkers: 1, minWorkers: 1 },
});
