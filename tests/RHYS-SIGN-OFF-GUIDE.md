# Rhys: how to fill in and sign the final report

**CZ update:** the later f76a5b84 refresh now defines R1–R8 restriction proposals; use tests/validation/RESTRICTIONS-AND-ASSUMPTIONS.md and docs/handover/R1-R8-CODE-CHECK.md for their corrected meanings. The older audit-label search below is historical and does not mean the refreshed key is undefined. Protocol counts here remain the older 6/15/9; do not transfer them into the refreshed 6/14/8 form without a recorded scope decision. No acceptance is inferred.

Open `tests/validation/VSR-TEMPLATE.md`. This is the form you are filling in. It is blank and says **NOT VALIDATED**. A green test run or this guide does not fill it in for you.

Keep a dated working copy with the evidence for the version you tested. Keep real JNR details and signed reports in the private evidence folder. Do not replace the shared blank template with customer details. Code can help find files and count results. **You make the decision. The reviewer signs their own line.**

## 1. Put the right name on the report

Fill the first two lines like this. Do not copy an old version label just because it is already in a handover.

| Box on the form | What to write | Where to get it |
| --- | --- | --- |
| Company | JNR, and any other company actually included in this review | The test record and agreed scope; `tests/validation/URS.md` company box |
| Intended use | The work you are approving: for example, the named shop's quoting, jobs and invoicing. Name anything excluded. | The use agreed in `tests/validation/URS.md`; John's completed `tests/JOHN-PQ-RUN-SHEET.md` when included in the reviewed pack |
| Release / commit | The full version label of the exact tested software | Code's completed `tests/validation/IQ.md`, IQ-001, and its saved version report. It must match the release evidence. |
| Environment | The address/name of the copy that was tested; say whether it was a practice copy | Completed IQ-004 and the header of the completed `tests/MANUAL-CHECKS-GO-LIVE.md`. Keep passwords and connection secrets out. |
| Testing dates | First and last dates the listed checks actually ran | Dates on the completed IQ, OQ and PQ rows and saved reports |
| Prepared by | The person who put this report together | Their real name; not the name of a tool |
| Validation lead (Rhys) | Your name | You |

If Code cannot show which version or which copy was tested, stop here and keep the decision **NOT APPROVED**.

## 2. Fill “What was tested” with file names you can open

Write the full private evidence path or stable report link, its date and the tested version beside each entry. A file name saying “PASS” is not enough: open the result and check what it covers.

| Box on the form | Take it from | What to check before copying the reference |
| --- | --- | --- |
| Approved URS revision | `tests/validation/URS.md`, the completed, accepted requirements list | The version of the list you agreed to test, with your name/date. All 15 requirements are accounted for. |
| Risk assessment revision | `tests/validation/RISK-ASSESSMENT.md`, your completed risk list | Likelihood and remaining-risk acceptance boxes are filled by the right person. Copy the agreed file version/date, not just a draft's title. |
| IQ evidence | Completed `tests/validation/IQ.md` plus the reports named in each of its six rows | All six setup checks have actual results, tester/date and evidence for this installation. |
| OQ evidence | Completed `tests/validation/OQ.md`, its named test logs, and completed `tests/MANUAL-CHECKS-GO-LIVE.md` | All 15 functional checks have their full expected result proved. A few passing unit tests do not complete a screen or database check. |
| PQ evidence | Completed `tests/validation/PQ.md`; John's completed `tests/JOHN-PQ-RUN-SHEET.md` when included; separate PQ-009 transfer evidence | The official form has **nine**, not eight, PQ steps. John's first eight do not complete the ninth. Include tester/date and the private notes for each. |
| Completed traceability matrix | Completed `tests/validation/TRACEABILITY.md`, supported by `tests/GO-NO-GO-EVIDENCE.md` | Every requirement points to an actual dated result or an openly recorded missing result. A link to an unrun test is not proof. |
| Commands, tool versions and dated logs | Completed IQ-002, IQ-003 and IQ-006; the actual final-version test reports; the matching `tests/validation/evidence/<dated-folder>/summary.json` and logs where applicable | Code shows Node/npm versions, the locked install result, exact commands, exit codes and counts. The summary's tested version must match. Include database, browser and manual reports separately. |

`tests/validation/CURRENT-RESULTS.md` explains the older unit results and their limits. The dated folders it names belong to their recorded older versions. Do **not** copy their counts as proof for a new version. `tests/validation/OUTSTANDING-CHECKS.md` and `tests/validation/COVERAGE-GAPS.md` show what still needs proof. Read both.

The go/no-go register also needs actual backup/restore, release order, money comparison, import and protected-record evidence. Get the private evidence file names from Code. Do not invent a report name or treat a fake dry run as the real data transfer. The authoritative Operations Pack still has to be supplied and checked line by line.

## 3. Fill every results-table cell

The three rows are **IQ**, **OQ** and **PQ**. Use the completed rows in the matching file, not the number of assertions in a program log.

| Row | Planned steps stays | Passed cell | Failed cell | Not run cell | Evidence index cell |
| --- | --- | --- | --- | --- | --- |
| IQ | 6 | Count fully passed IQ-001–IQ-006 | Count final failed IQ steps | Count missing, partial or unperformed IQ steps | Link the completed IQ file and its six evidence entries |
| OQ | 15 | Count fully passed OQ-001–OQ-015 | Count final failed OQ steps | Count missing, partial or unperformed OQ steps | Link the completed OQ file, actual test reports and required manual results |
| PQ | 9 | Count fully passed PQ-001–PQ-009 | Count final failed PQ steps | Count missing, partial or unperformed PQ steps | Link the completed PQ file, John's sheet and separate PQ-009 evidence |

For each row, **Passed + Failed + Not run must equal Planned steps**. Write `0` if the real count is zero; do not leave it blank. A partly completed step is not a full pass. If one required part failed, record the step as failed; otherwise an unfinished step belongs in Not run. Retain the detail so no missing part disappears.

If a problem was fixed and the complete affected step was rerun successfully on this version, count its final result once. Keep the earlier failure and the retest in the problem table. Do not add old and new attempts together. If nothing in a protocol has genuinely run, its row has zero passed, zero failed and all planned steps Not run.

## 4. Fill the problem table, one problem per row

| Cell | What to write | Take the facts from |
| --- | --- | --- |
| Deviation ID | A unique problem name, such as DEV-001 | Your problem log; keep the same name on the fix and retest |
| Requirement / failed or missing step | The exact URS, IQ, OQ, PQ or manual check number | The failed/missing result and `TRACEABILITY.md` |
| What happened | What you expected, what actually happened, and the difference | Actual failed log, screenshot or tester's private note |
| Fix or restriction | The actual fix, or exactly what work is not allowed | Code's reviewed fix and your written limit. “Be careful” is not a usable limit. |
| Retest evidence | The file showing the affected check was run again and its result | The actual dated retest on the intended version. If absent, write NOT RUN. |
| Owner / due date / acceptance | Who must fix it, by when, and who accepted any remaining limit with a date | The named person's agreement and your recorded decision |

Keep failures, missing runs, unexplained skips, missing reports and differences from SliQ visible. If there are no remaining problems, write “None” only after checking the outstanding list and every required result. A **failed high-risk check blocks release until fixed and retested**. Do not hide it by changing the requirement or calling it a limit.

## 5. Choose exactly one Decision

On the form, the line is:

`Decision: NOT APPROVED / APPROVED WITH RECORDED LIMITS / APPROVED (select one): ____`

Write one of those three choices in the blank. Use this rule:

| Choose | When it fits |
| --- | --- |
| **NOT APPROVED** | A high-risk check failed; essential proof is missing; a required check is unrun; the version does not match; or you cannot yet accept safe use. The currently recorded missing database/browser/restore/import evidence supports this choice, not approval. |
| **APPROVED WITH RECORDED LIMITS** | The agreed permitted use has actual accepted evidence; no failed high-risk check remains; every excluded use and remaining problem has a specific accepted limit, owner and reason. Record exactly what people may and may not do. Required backup, database, wipe and other mandatory release proofs cannot be waived by this choice. Unfinished conditions before use still mean do not start that use. |
| **APPROVED** | Every required check for the agreed use has accepted evidence for the intended version, problems are resolved/retested, mandatory gates and independent review are complete, and you accept the remaining risk. A green CI badge alone does not meet this rule. |

Then fill **Reason and remaining risk** with why that choice is justified and what could still go wrong. Fill **Conditions before use** with the exact unfinished actions and owners, or “None” only if there really are none. If a listed condition is still unmet, do not start the affected work.

A signed NOT APPROVED report is a valid record of your decision. It is not permission to go live. An approval of the quality report is also not an instruction for a builder to merge, deploy or run production SQL; those retain their separate controls.

## 6. Sign the right line and keep the proof

1. Find **Rhys, validation lead, name / signature / date** at the bottom. Enter your full name, your own signature and the actual date you make the decision. Do not backdate it.
2. The independent reviewer fills **Reviewer name / signature / date** with their own name, signature and date after reviewing the same evidence. Code does not sign for them.
3. Save the signed report, completed check sheets, problem log and referenced evidence together. Keep the exact tested version label with them.
4. Keep the old evidence if code, settings or working methods change. Ask Code and the reviewer which affected checks must be repeated; do not carry an old approval onto changed work automatically.

## What R1 to R8 means here

**The VSR and current risk list do not define a single “R1–R8” sign-off list.** The official risk IDs are `RISK-001` through `RISK-015`. Do not silently turn R1 into RISK-001, and do not mistake old job-board labels such as R3.1 for this list.

Some older source comments and tests do use standalone audit labels. These are the meanings supported by those files, not eight invented release gates:

| Label | Plain meaning supported by the repository | Where it is stated |
| --- | --- | --- |
| R1 | When an admin sets a password, save the required password-change rule first. A failed or uncertain save must not be reported as a completed change. | `app/api/admin/users/password/route.ts`; `tests/unit/admin-password-auth-failure.test.ts`; `tests/e2e/password.spec.ts` |
| R2 | An order made from an accepted quote must carry the quote's correct net value and VAT. Refuse a link that cannot keep the money exact. | `lib/order-from-quote.ts`; `tests/unit/order-from-quote.test.ts` |
| R3 | In the combined R2/R3 quote-link check, changing the chosen quote clears the previous value and VAT straight away. Saving waits for the newly chosen quote's lines. The files discuss R2 and R3 together; they do not give a separate universal R3 definition. | `app/(dashboard)/sales-orders/page.tsx`, comment above `pickQuote`; `tests/e2e/quote-to-job.spec.ts` |
| R4 | A draft's first send or decision uses today's company/customer details. An already issued quote keeps its saved details. | `app/(dashboard)/quotes/page.tsx`; `tests/e2e/send-confirmation.spec.ts` |
| R5 | Printed sign-off belongs to the current worksheet version. An old typed name or an earlier signed version must not pretend the changed sheet is signed. | `lib/job-worksheet.ts`; `tests/unit/sign-off.test.ts`; `tests/e2e/worksheet.spec.ts` |
| R6 | **No definition found for standalone R6 in the reviewed public candidate.** Do not make one up. | No authoritative R6 entry found; the separate “#6” pause-role tests are not labelled R6. |
| R7 | Only say a change succeeded when the record really changed. If a record disappeared or access was lost, show the shortfall instead of false success. | `tests/e2e/zero-rows.spec.ts`; `tests/e2e/send-confirmation.spec.ts` |
| R8 | **No definition found for standalone R8 in the reviewed public candidate.** Do not make one up. | No authoritative R8 entry found; the separate “#8” reconnect tests are not labelled R8. |

If your review packet uses R1–R8 for something else, get its original definitions before closing those items. Keep them listed as undefined until the source is supplied. Use the actual URS/RISK/OQ/PQ IDs for this form.

Source: the VSR, IQ/OQ/PQ, URS, risk, traceability and evidence files on PR #284 head d7d6ff9dbd915becdc096d1eb365e4a73b4ae21d. Standalone audit labels were checked in that candidate's application, library and test sources. This guide fills no result, acceptance or signature and changes no shared validation template.
