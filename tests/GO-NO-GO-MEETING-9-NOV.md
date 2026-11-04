# Monday 9 November: are we ready for Thursday?

**One-page meeting sheet · UK time ____ · Rhys chairs · John, Code and independent reviewer attend.**

Bring the private evidence folder. Code writes the exact checked software version: ____. Each result must name its real report and date. A blank form or a test file is not a passed check. No new features today.

| Ask this, in order | Who decides | Open this evidence file; record the actual private report beside it |
| --- | --- | --- |
| 1. Are we all looking at the same version and complete check list? | Code identifies it; reviewer checks; Rhys agrees scope. | `tests/validation/EVIDENCE-INDEX.md`, `MANUAL-35-VS-64.md` and `tests/BA-FIRST-DAY-EVIDENCE.md`. Obtain the exact Operations Pack; do not guess its missing rows. |
| 2. Can we get our records back if this goes wrong? | Code demonstrates; reviewer checks; Rhys accepts the measured recovery plan. | `tests/GO-LIVE-DB-RUNBOOK.md`; **Friday 6 dump, restore-and-complete-comparison report**, including stored files/access and recovery time. A backup filename alone is not enough. |
| 3. Did Saturday’s agreed clearing preserve everything it should? | Code shows proof; John checks JNR; reviewer checks protection. | `tests/CUTOVER-DAY-CHECKLIST.md` steps 14–16 and exact private combined-kit/18-CW report. Marpet, logins, settings, numbers and audit must match. Missing kit/review/report means STOP. |
| 4. Do SliQ and the trial transfer agree? | John and accounts confirm records, pennies and unfinished-work cost; Code explains gaps. | `tests/GO-LIVE-DATA-LOAD.md`, `tests/SLIQ-EXPORT-REQUEST-JOHN.md`; actual original exports, real dry-run/complete-comparison reports and next-number list. Fake wrapper results are not a real import. |
| 5. Can John and staff do their work on their devices? | John reports; Rhys accepts business readiness. | `tests/UAT-JOHN-DESKTOP-WORKSHOP.md`, corrected `tests/JOHN-PQ-RUN-SHEET.md` and actual private completed sheets. Missing device, failed or unrun required step stays open. |
| 6. Have the technical safety checks really passed? | Independent reviewer gives verdict; Code supplies results. | `tests/GO-NO-GO-EVIDENCE.md`, `tests/RELEASE-GATE.md`; actual same-version SQL/browser/provider/race/parity/upgrade reports. `tests/CV-CURRENT-STACK-RESULTS.md` proves only its stated local checks. |
| 7. Who may use AI, accounting and email? | John decides data-sharing/business use; Rhys decides enabled scope after review. | Completed private `docs/signoff/AI-APPROVE-JOHN-DATA-SHARING.md`, provider sheets and `tests/B5-EMAIL-CONNECTION-PROOF-AND-FALLBACK.md` (#295). No approval: leave that feature off. |
| 8. Are Tuesday/Wednesday’s admin-code checks owned and booked? | Rhys names primary/cover admins; Code arranges both days’ checks. | `docs/signoff/B17-ADMIN-SIGN-IN-CODES.md`. Require actual sign-in challenge/refusal and cover access. Monday’s booking is not a passed security check. |
| 9. Who can stop work, recover it and tell staff? | Rhys decides; John agrees shop/paper process; Code confirms technical recovery. | Completed private G14 opening-day, C8 contacts and F6 acceptance sheets; fill cut-off, recovery time, deputy and paper owner. No reachable decision maker means stay stopped. |
| 10. What is still missing? | Rhys records the Monday decision; he signs the VSR only when evidence is complete. John signs his own acceptance. | `tests/validation/VSR-TEMPLATE.md`, exact evidence index and corrected R1–R8 review. Reconcile older 6/15/9 versus refreshed 6/14/8 scope before counting results. |

**Write one Monday outcome:** [ ] STOP [ ] Continue preparation for Thursday, subject to the listed checks. Reason / missing evidence / each owner and deadline: ____.

Monday is not permission to skip Tuesday/Wednesday checks, use an unapproved feature, run SQL or open live work. Rhys makes the separate final GO/STOP after Thursday’s verified releases, transfer and smoke results. A required failure, missing proof, changed version, unsafe recovery or unaccepted restriction means STOP the affected use; no deadline turns it into Pass. No 146 reapply after rollback.

Rhys / signature / time: ____  John / date: ____  Code / reviewer: ____ / ____

Source pack: CS #299, CT #300, BA #317, CP #288, corrected CN #286, B4/D5 #319, G9/C6 #320. Builder 4’s latest plain sign-off masters are #316 at `359249878c17b7e4586e39bbee4b7e3961c2a2e2`, under `docs/signoff/`; complete them privately. B5’s exact source is [#295 files](https://github.com/rhyshume1997-alt/tolra-public/pull/295/files). These references are planning/evidence requests, not completed results.
