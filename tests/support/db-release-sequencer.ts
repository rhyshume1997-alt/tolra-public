import type { Vitest } from "vitest/node";

// Type-only imports: the config that loads this file is bundled as CommonJS, and "vitest/node" is ESM-only, so a runtime import of it
// (extending BaseSequencer) stops the whole database suite at "failed to load config". This sequencer needs nothing from it at runtime.
type SpecLike = { moduleId: string };
export const post144ProofFiles = ["company-setup-isolation.test.ts", "tolra-provided-ai.test.ts", "tolra-ai-cap-concurrency.test.ts"];
export function releaseRank(file: string) { return post144ProofFiles.some(name => file.replaceAll("\\", "/").endsWith(`/tests/db/${name}`)) ? 1 : 0; }
/** No files excluded: frozen baseline checks finish before one-time release proofs change the schema. Within each group, files run in path order. */
export default class ReleaseSequencer {
  constructor(public ctx: Vitest) {}
  async shard<T extends SpecLike>(files: T[]): Promise<T[]> { return files; }
  async sort<T extends SpecLike>(files: T[]): Promise<T[]> {
    return [...files].sort((a, b) => releaseRank(a.moduleId) - releaseRank(b.moduleId) || (a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0));
  }
}
