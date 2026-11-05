# G32 public cutover order reconciliation

**The one controlling cutover runbook is [CONTROLLED-CUTOVER-2026-11-12.md](../runbooks/CONTROLLED-CUTOVER-2026-11-12.md).** This designation implements Rhys's requested sequence; named human release/step approvals remain UNPROVEN. No production action is authorised here.

The previous 32 exact-version patch proposals are **SUPERSEDED** and removed. Do not apply them or rewrite 32 files. Earlier sequence instructions in the public versions below are **SUPERSEDED** by the controlling runbook. Their technical checks, original failures and historical evidence remain reference material; they cannot override the current order or authorise a restore. Other builders' source files were not edited.

The original 458-version public-source inventory and 157 sequence-reference observations remain in G32-PUBLIC-DOC-INVENTORY.json. These are not 157 separate defects. Original read hashes, file versions and line references remain; patch IDs now identify withdrawn proposals, not files to apply.

| Public source/version | Earlier sequencing status | Current authority |
| --- | --- | --- |
| `tests/reviews/g33/README.md` at `d849a4221508325401c570f50f96a1d99474ed96` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `docs/iso9001/jnr/QUESTIONNAIRE-RHYS.md` at `31233db64f2a01a6b2e68468c8b123b825db2e47` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `docs/handover/SLIQ-LOAD-RUNBOOK.md` at `83a2826b29ca6fdb139f4a0e7812d103865426be` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `docs/handover/C16-CUTOVER-CONTROLS-12-NOV.md` at `7f3a8d48e7bc498628c175e62ed50419b4841856` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `docs/handover/C10-146-ONE-TIME-MIGRATION-RUNBOOK.md` at `74f8cb84258d856ccee2eed16b0c522fa803cf73` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `docs/handover/C03-MANUAL-CHECKS.md` at `7f3a8d48e7bc498628c175e62ed50419b4841856` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `docs/handover/C16-CUTOVER-CONTROLS-12-NOV.md` at `034ef62ebba6d882c92c351802dd9c3ba5ffc02c` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `docs/signoff/R1-R8-ACCEPT-SHEET.md` at `380f60c5ce8dfc543f482b5a23086a0b5a85a1f5` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `docs/handover/C03-MANUAL-CHECKS.md` at `ad4f506606689292edbd68d5390b864d0b3d7e83` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `docs/runbooks/WIPE-DAY-SATURDAY-7-NOVEMBER.md` at `ad59e3b62a355d1241357eb53e3d24385c4ec6ed` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `tests/CODEX-PR-MERGE-ORDER.md` at `19b1d6a3f09502d798c1d09618cefa3f17f8cc01` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `tests/validation/RESTRICTIONS-AND-ASSUMPTIONS.md` at `1b4ed92dcd4337e2c0bde4c67520ac3055aba72e` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `tests/CUTOVER-DAY-CHECKLIST.md` at `ce2e6cc1268e5965a490f839083ab0fcd17eeae7` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `docs/signoff/BUILDER-3-CROSS-REVIEW.md` at `ce1118393cc0d65bfde426d31222903a802984ff` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `tests/GO-NO-GO-EVIDENCE.md` at `bcf29b1589dfe9a15a593c583984e6c457690b1d` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `tests/GO-NO-GO-EVIDENCE.md` at `b80b274b0f2b8b12444915152383564cc1b9bf52` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `tests/CJ-BUILDER-3-RESULTS.md` at `ff29ca191879ec954e305ec0eb200501789a5bcf` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `tests/REVIEW-PACKETS-NEXT.md` at `f4eacee2236e65e52fdccbdf5cf8f8045fd95d80` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `tests/validation/README.md` at `f4eacee2236e65e52fdccbdf5cf8f8045fd95d80` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `tests/validation/IQ.md` at `f4eacee2236e65e52fdccbdf5cf8f8045fd95d80` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `tests/GO-LIVE-DB-RUNBOOK.md` at `f4eacee2236e65e52fdccbdf5cf8f8045fd95d80` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `tests/GO-NO-GO-EVIDENCE.md` at `f4eacee2236e65e52fdccbdf5cf8f8045fd95d80` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `tests/RELEASE-GATE.md` at `f4eacee2236e65e52fdccbdf5cf8f8045fd95d80` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `tests/HANDOVER-BUILDER-3.md` at `9caf9ed59b388de5168b476522ca0230067f9845` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `tests/GO-LIVE-DB-RUNBOOK.md` at `9795ee1a8f5985dcaffb7823f9d55ded8698892d` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `tests/GO-LIVE-DATA-LOAD.md` at `d73bb240a23b38a7080c0933e4f5b62ddd529f5f` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `tests/GO-LIVE-DATA-LOAD.md` at `e26fd743e5145f5d9ee56878cc3733d88d147bdf` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `tests/GO-LIVE-DB-RUNBOOK.md` at `87c4bbf52b895c1e618d32205e5023adb4d60cbc` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `tests/MORNING-CHECKLIST.md` at `14e7291070a99ee10658da2781699859310124c7` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `tests/MORNING-CHECKLIST.md` at `6be692d3e3fde62baed099c71dc518bfbf2930a5` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `tests/HANDOVER-CODEX-1.md` at `9caf9ed59b388de5168b476522ca0230067f9845` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |
| `docs/handover/WIPE-AND-GO-LIVE-PLAIN.md` at `88ebf7811f091d18e2524ed0598567f74f8b934f` | **SUPERSEDED** | CONTROLLED-CUTOVER-2026-11-12.md |

Read-only documentary checks replace the withdrawn patch-application checks: source inventory remains pinned; only one runbook controls; freeze and ordered stages are explicit; each required STOP blocks the next dependent step and never automatically restores. No SQL/database/import/deploy/smoke was executed.
