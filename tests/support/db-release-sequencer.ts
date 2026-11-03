import { BaseSequencer, type WorkspaceSpec } from "vitest/node";
export const post144ProofFiles = ["company-setup-isolation.test.ts", "tolra-provided-ai.test.ts", "tolra-ai-cap-concurrency.test.ts"];
export function releaseRank(file: string) { return post144ProofFiles.some(name => file.replaceAll("\\", "/").endsWith(`/tests/db/${name}`)) ? 1 : 0; }
/** No files excluded: frozen baseline checks finish before one-time release proofs change the schema. */
export default class ReleaseSequencer extends BaseSequencer {
  async sort(files: WorkspaceSpec[]) {
    const sorted = await super.sort(files);
    return sorted.sort((a,b) => releaseRank(a.moduleId) - releaseRank(b.moduleId));
  }
}
