import type { Vitest } from "vitest/node";

// Vitest bundles this config as CommonJS; vitest/node is ESM-only.
// Keep its import type-only so loading the database config needs no ESM runtime import.
type SpecLike = { moduleId: string };
export const post144ProofFiles = ["company-setup-isolation.test.ts", "tolra-provided-ai.test.ts", "tolra-ai-cap-concurrency.test.ts", "f1-ai-setup.test.ts", "wc-ai-cap-paths.test.ts", "job-delivery-note-147.test.ts", "dln-day-of-counter.test.ts", "job-profitability-148.test.ts", "xero-launch-hold-149.test.ts", "xero-launch-paths-149.test.ts", "xero-held-backlog-approval.test.ts", "ai-cap-key-off-150.test.ts", "xero-invite-151.test.ts"];
/**
 * 151 proof files that call preparePost144Fixture (so they install 145..151 on the database themselves). An unlisted file has rank 0, runs among the frozen
 * baseline checks and would install the post-144 releases in the middle of them, and nothing would notice. They are ranked with the proofs (rank 1), ahead of
 * the ordered list: tests/unit (go-live-candidate-order, post-144-release-fixture) pin post144ProofFiles as exactly its 13 entries ending in xero-invite-151,
 * so these are a separate list rather than extra entries in it. Any of them installs 145..151 itself, as the first ordered proof does.
 */
export const post144ExtraProofFiles = ["xero-151-permissions.test.ts", "xero-invite-store-picker-151.test.ts", "xero-invite-cancel-during-callback-151.test.ts", "xero-invite-late-write-151.test.ts", "release-order-guards.test.ts", "rollback-data-refusal.test.ts", "release-upgrade-populated-145-151.test.ts", "sliq-import-route-152.test.ts", "delivery-note-roles-after-cutover.test.ts", "document-customer-link-153.test.ts", "customer-portal-signin-154.test.ts"];
const norm = (file: string) => file.replaceAll("\\", "/");
function extraIndex(file: string) { return post144ExtraProofFiles.findIndex(name => norm(file).endsWith(`/tests/db/${name}`)); }
// Extras sort first among the proofs (negative key), in list order; ordered proofs keep their index.
function proofIndex(file: string) { const e = extraIndex(file); return e >= 0 ? e - post144ExtraProofFiles.length : post144ProofFiles.findIndex(name => norm(file).endsWith(`/tests/db/${name}`)); }
export function releaseRank(file: string) { return extraIndex(file) >= 0 || proofIndex(file) >= 0 ? 1 : 0; }
/** No files excluded: all frozen baseline checks finish before proofs, in 145, 146, 147, 148, 149, 150 then 151 order. */
export default class ReleaseSequencer {
  constructor(public ctx: Vitest) {}
  async shard<T extends SpecLike>(files: T[]): Promise<T[]> { return files; }
  async sort<T extends SpecLike>(files: T[]): Promise<T[]> {
    return [...files].sort((a, b) => releaseRank(a.moduleId) - releaseRank(b.moduleId)
      || proofIndex(a.moduleId) - proofIndex(b.moduleId)
      || (a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0));
  }
}
