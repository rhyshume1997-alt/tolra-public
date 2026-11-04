import type { Vitest } from "vitest/node";

// Vitest bundles this config as CommonJS; vitest/node is ESM-only.
// Keep its import type-only so loading the database config needs no ESM runtime import.
type SpecLike = { moduleId: string };
export const post144ProofFiles = ["company-setup-isolation.test.ts", "tolra-provided-ai.test.ts", "tolra-ai-cap-concurrency.test.ts", "job-delivery-note-147.test.ts", "dln-day-of-counter.test.ts"];
function proofIndex(file: string) { return post144ProofFiles.findIndex(name => file.replaceAll("\\", "/").endsWith(`/tests/db/${name}`)); }
export function releaseRank(file: string) { return proofIndex(file) >= 0 ? 1 : 0; }
/** No files excluded: all frozen baseline checks finish before proofs, in 145, 146 then 147 order. */
export default class ReleaseSequencer {
  constructor(public ctx: Vitest) {}
  async shard<T extends SpecLike>(files: T[]): Promise<T[]> { return files; }
  async sort<T extends SpecLike>(files: T[]): Promise<T[]> {
    return [...files].sort((a, b) => releaseRank(a.moduleId) - releaseRank(b.moduleId)
      || proofIndex(a.moduleId) - proofIndex(b.moduleId)
      || (a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0));
  }
}
