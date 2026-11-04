# Builder 5 handover — ISO support documents for JNR

Document ID: JNR-I7-HANDOVER | Version: 0.1 draft | Prepared: 4 November 2026

Owner: builder 5 for this handover; proposed ongoing technical owner Rhys. JNR document owners, approval/effective dates and review dates are still to be appointed/completed by John.

Tolra supports JNR Engineering’s quality work. Software and documents cannot make a company certified. JNR is the company that gets audited. This pack does not establish compliance, validation, certification or permission to go live.

## Short tick list

- [x] Read root AGENTS.md on main and ownership from #271 at `0d3a481524bdfbcdbfe29382b76b858f9dd203a4`; main has no ownership file. Existing owner rows retained.
- [x] Published atomic `claims/I1` through `claims/I7`, without overwriting any claim. This handover is builder 5’s own ledger under the requested `docs/iso9001/` path.
- [x] Prepared I1–I7 on separate branches, with one draft PR per job, all based on main `68f89ca7b801a10587ff9b51d6c820462847b65a`.
- [x] Reviewed source facts, blank approvals, certification wording and source links; each job passed `git diff --check`. All seven published trees match their local committed trees; final handover-only updates are compared again.
- [ ] John/adviser reviews and adapts the pack, reconciles existing private documents, appoints owners and supplies real company evidence.
- [ ] Rhys/operator provides actual installed-version, validation, recovery and release evidence through existing approval routes.

## Ownership and PR map

All jobs belong to builder 5 under Rhys’s explicit assignment. Builders 3 and 4 were read only; their branches, files and jobs were not changed. Their runbooks and sign-off sheets remain authoritative separate drafts, not copied or signed here. No Ready label, main merge, production SQL, deployment or feature build occurred.

| Item / claim | Branch | Draft PR | Published commit |
| --- | --- | --- | --- |
| I1 / `claims/I1` | `codex/b5-i1-iso9001` | [#335](https://github.com/rhyshume1997-alt/tolra-public/pull/335) | `b2948a8a64086d2e6b6244633f7e0eb3a3406a46` |
| I2 / `claims/I2` | `codex/b5-i2-iso9001` | [#336](https://github.com/rhyshume1997-alt/tolra-public/pull/336) | `b30d8dea204162c9baded499de7fef516d526b57` |
| I3 / `claims/I3` | `codex/b5-i3-iso9001` | [#338](https://github.com/rhyshume1997-alt/tolra-public/pull/338) | `77c8cc34639dfa72d1d96509c27cded7098b039d` |
| I4 / `claims/I4` | `codex/b5-i4-iso9001` | [#339](https://github.com/rhyshume1997-alt/tolra-public/pull/339) | `f9f43f18e2ad1a5c14031fd4139691a6db54189c` |
| I5 / `claims/I5` | `codex/b5-i5-iso9001` | [#340](https://github.com/rhyshume1997-alt/tolra-public/pull/340) | `2429eda5831a93f6966a89ec8ba8c6a4dde2e1ae` |
| I6 / `claims/I6` | `codex/b5-i6-iso9001` | [#341](https://github.com/rhyshume1997-alt/tolra-public/pull/341) | `67f8ebb871c26f4337a4318253a056ac316849f6` |
| I7 / `claims/I7` | `codex/b5-i7-iso9001` | [#342](https://github.com/rhyshume1997-alt/tolra-public/pull/342) | See this PR’s current full head; handover updates change its hash |

## What each job contains

| Job | Deliverables and practical limits |
| --- | --- |
| I1 | Clause map 4–10 with pinned feature/file/test evidence; whole clauses remain Partly or outside Tolra, with narrow software tasks separately Supported. Source presence is not a runtime pass. |
| I2 | Blank document register plus 158 public paths/revision variants, proposed owners and a revision/approval procedure. Covers main, diagnostic refresh and document changes in 180 open PRs in the pre-builder-5 snapshot. Does not claim the private JNR estate is complete. |
| I3 | Blank policy/objectives sheets with separated examples. No invented targets, baseline, approval or effective date. |
| I4 | Eight short procedures, 358–408 words each, for John to adapt/adopt. Check printed layout before issuing as a page. Real operation, competence, physical labels and gauge checks remain JNR work. |
| I5 | Source risks RISK-001–015 from CE #276, later 001–014 refresh difference explained; separate cutover risks and shop prompts; blank likelihood/acceptance and action/review fields; opportunity ideas. |
| I6 | Blank first internal-audit checklist and management-review agenda, with required inputs, evidence, findings/actions, decisions/resources and follow-up. No audit or meeting performed. |
| I7 | Feature gaps and proposed before-go-live external controls / after-go-live software ideas; this handover. No feature built and no scope decision approved. |

## Source and verification boundaries

Public source/main, open-PR document files and pinned builder 3/4 evidence were read. Private Operations Pack and JNR’s current quality masters were unavailable; no completeness or sign-off is inferred. The full open-PR document snapshot ended at #322; new builder work after that snapshot requires reconciliation before approval. Competing draft versions remain listed separately.

The validation pack CE #276 at `e71a80072148077a4c0f05184fe40d79688c01ee` and diagnostic refresh `f76a5b84da1f01626cc81d17150e08e6069ef794` are mappings/evidence sources, not signed validation. Existing event audit, job numbers, quotes/orders, material fields, hours, access controls and backup tools were checked against source. Supplier status and inspector authorisation already exist; the gap list describes missing evaluation/competence workflows rather than saying those features are absent. Job Problem does not block Start/Finish, and admin early release exists: JNR must control both in its process.

Checks performed: source review, main-source path existence, all document draft/certification statements, document inventory pagination (including both #247 pages), exact tree comparison and per-job whitespace checks. These are documentation checks. No runtime tests were needed or run, and no database/browser/provider/backup/restore/audit/management-review/approval operation was performed. Referenced tests are evidence locations, not new pass claims. Git CLI network access failed at the configured proxy, so publishing used the connected GitHub tools; local commits and remote trees were compared.

## What only John or an ISO adviser can decide

- JNR’s quality-system scope, sites, work and any justified non-applicability, especially design/development; customer, legal and special-process requirements for CNC/fabrication/welding.
- Whether these drafts match actual practice; who owns, checks, approves and uses each master; how existing procedures and private documents are reconciled; retention, legal holds and controlled-copy rules.
- Policy wording, objectives/targets/counting rules, resources, supplier acceptance/review criteria, competence evidence, inspection/concession authority and risk acceptance. John retains management responsibility; an adviser can help assess requirements.
- Audit programme, competent impartial auditor, findings/actions, management-review conclusions and evidence needed to seek certification. Only a certification body can award accredited certification after auditing JNR.

Rhys and the technical operator must additionally decide software scope/release readiness, prove the actual installed system and recovery route, and use the existing validation/release sign-off process. John and Rhys decide whether external controls are sufficient for use and which proposed features, if any, should be scheduled later. Nothing in this handover fills their signatures.

## Next integrator

Review each independent draft. Keep all ISO files under `docs/iso9001/`; preserve builders 3 and 4’s masters. Reconcile the inventory against the final combined tree and private Operations Pack. Select one controlled revision of each document. Complete the blank owner/approval/retention/risk fields only after actual review. Resolve every required missing control or failed high-risk check before relying on the system. Any merge, production operation or go-live decision remains with the separately authorised people and existing gates.
