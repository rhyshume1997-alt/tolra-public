# Required JNR SliQ release package

CA is an explicitly assigned integration, not a takeover of Claude's held SliQ implementation. Source: claude/sliq-import at 3593615eb34c2dd66b152ca3eaca227bd8475f5f. Original branch unchanged. Final #247 base is 41c685c416305637d86b580324fff9e6cda037ff. John's SliQ data is required at cutover, so 140 and 141 are required, not optional.

Actual cutover order: **138, 140, 141, 144, 145, 146**. 140 preserves source references; 141 stores opening WIP with company-scoped read-only access. Their existing implementation bodies are copied without changing held-owner functions/policies. The reviewed 138 verification is a new packaging prerequisite for 140; 140 verification is required before 141. Files/checksums are listed in supabase/cutover-import-plan.json and sliq-cutover.checksums.json. Run node scripts/check-cutover-imports.mjs read-only before review. No checksum is approval.

140 rollback already refuses imported source references. CA additionally makes the copied 141 rollback refuse any WIP rows, instead of silently dropping import data. After import, do not erase data to force a rollback. Keep backup/reconciliation evidence and get a separate recovery decision. No source-owner file or original branch was changed.

The frozen numbered database catalogue/baseline tests are unchanged. Only on an identity-verified disposable backend, the new post-baseline SQL proof prepares 140/141 after frozen baseline files, then existing 145/146 proofs follow. This test chronology, with 144 already in the frozen baseline, is not the cutover order; the independent fresh restore/upgrade rehearsal must prove the declared real cutover order above. No test is excluded or weakened to hide this distinction.

- [ ] Real disposable ordered install/verify and repeated preflight proof on the exact candidate.
- [ ] Two-company source-ref and opening-WIP role/write/link tests execute, with no skips.
- [ ] Original-reference and nonempty-WIP rollback refusal, plus empty rollback preservation.
- [ ] Independent cutover-order restore/upgrade rehearsal and backup integrity proof.
- [ ] John's actual export headers and private totals signed by John/Rhys at cutover; only fake data used here.

142/143 and costing atomic settings stay out unless separately assigned and reviewed. No SQL applied to real data, no merge/deploy/go-live approval. A reviewer SAFE verdict and all required actual evidence remain external decisions.
