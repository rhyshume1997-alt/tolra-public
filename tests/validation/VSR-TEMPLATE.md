# Validation summary report (VSR) template

Company: ____  Intended use: ____  Release / commit: ____  Environment: ____
Testing dates: ____  Prepared by: ____  Validation lead (Rhys): ____

## What was tested

Approved URS revision: ____  Risk assessment revision: ____
IQ evidence: ____  OQ evidence: ____  PQ evidence: ____  Completed traceability matrix: ____
Commands, tool versions and dated logs: ____

## Results

| Protocol | Planned steps | Passed | Failed | Not run | Evidence index |
| --- | --- | --- | --- | --- | --- |
| IQ | 6 | ____ | ____ | ____ | ____ |
| OQ | 14 | ____ | ____ | ____ | ____ |
| PQ | 8 | ____ | ____ | ____ | ____ |

## Problems and remaining limits

| Deviation ID | Requirement / failed or missing step | What happened | Fix or restriction | Retest evidence | Owner / due date / acceptance |
| --- | --- | --- | --- | --- | --- |
| ____ | ____ | ____ | ____ | ____ | ____ |

Any failed high-risk step blocks release until fixed and retested. A not-run step is not a pass. Record any accepted restriction with its owner and reason; do not silently remove a requirement or weaken a test.

## Decision

Decision: NOT APPROVED / APPROVED WITH RECORDED LIMITS / APPROVED (select one): ____
Reason and remaining risk: ____  Conditions before use: ____
Rhys, validation lead, name / signature / date: ____  Reviewer name / signature / date: ____

This report records evidence for the company's quality process. It does not itself grant ISO 9001 certification. Reassess affected requirements after software, configuration or process changes and retain old evidence with the release it tested.

Required source documents: [IQ](IQ.md), [OQ](OQ.md), [PQ](PQ.md), [traceability](TRACEABILITY.md), [coverage gaps](COVERAGE-GAPS.md), [URS](URS.md), [risk assessment](RISK-ASSESSMENT.md). Reconcile every requirement, including external or unrun proofs, with dated evidence. An automated log never fills or grants this sign-off.
