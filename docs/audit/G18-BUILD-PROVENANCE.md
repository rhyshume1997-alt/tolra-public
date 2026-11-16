# G18 — Where this build came from

Draft 0.1 | Owner ____ | Form version/date ____.

**NOT EXECUTED.** Fill in one record per build artifact. Blank fields are not a pass or approval. Use synthetic evidence only in this public pack; keep keys, real records and private logs elsewhere.

This short build record adds an explicit **artifact-bytes hash** and build run ID. Reuse the profile/evidence map in [#370](https://github.com/rhyshume1997-alt/tolra-public/pull/370) and the log-chain verifier in [#377](https://github.com/rhyshume1997-alt/tolra-public/pull/377). A log hash does not prove the build file has the same bytes.

| Build record | Fill in after the work |
| --- | --- |
| Requirement ID | G18-BUILD-____ |
| Repository and branch | ____ |
| Exact checkout/executed SHA (all 40 characters) | ____ |
| Build command, dependency lock/config hash; uncommitted overlay hash or “none” | ____ |
| Build workflow/run ID and immutable link; attempt number | ____ |
| Runner/created disposable environment identity; synthetic input/profile hash | ____ |
| Start/end time and timezone; actual exit code | ____ |
| Artifact name/ID, size and immutable download reference | ____ |
| **Artifact SHA-256, computed from the downloaded artifact bytes** | ____ |
| Complete original log reference and separate log SHA-256 | ____ |
| Expected result | Executed SHA → build run → exact artifact bytes match; evidence is complete and independently checked |
| Actual result | ____ — **NOT EXECUTED** |
| Evidence reference, including failed/skipped checks and deviations | ____ |
| Tester and date | ____ / ____ |
| Independent checker: re-download/hash/SHA comparison and date | ____ / ____ |
| Approval: who approved, decision, signature and date | ____ / ____ / ____ / ____ |

Check the executed SHA, not a later PR head. Recompute the artifact hash after download; a filename or green badge is insufficient. Keep failed attempts and explain any missing or skipped result. A changed artifact, missing log or mixed run means STOP and resolve it. Record evidence retention/location ____.

No build or approval was performed for this template. The existing verifier is not claimed to check this new artifact hash field automatically. Approval here does not authorise a production migration, merge, deployment or live service.
