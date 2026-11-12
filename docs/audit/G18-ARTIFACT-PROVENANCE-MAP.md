# G18 — Artifact provenance map for Code

Version 0.1 draft | Prepared 4 November 2026 | Owner ____ | Approved issue/effective date ____.

**NOT EXECUTED.** Blank fields are not results or consent. Complete records privately after the work; no real data belongs in this public template. Tolra supports JNR’s quality work; JNR is audited, and these documents cannot certify it.

Use one complete record for **every artifact and profile**, including unsuccessful or incomplete runs. “Provenance” means showing exactly where a result came from. A filename or green badge is not enough.

Profiles to cover: `prod`, `realistic`, `x100`. These are profile labels to be defined by Code, **not permission to use production or real data**. Record synthetic fixture identity and scale. Do not reuse one profile’s evidence for another without a reviewed explanation.

## Copy this complete record

Requirement ID: G18-ART-____.

Artifact ID/name ____; immutable artifact/run link ____; profile (`prod` / `realistic` / `x100`) ____; profile definition/version ____; synthetic input/fixture hash ____.

Exact checkout SHA ____; repository/ref ____; any overlay/change and its hash ____; command/config version ____; runner/database identity and schema/release fingerprint ____.

Exit code ____; log filename/private location ____; log SHA-256 ____; hash checked against the retained bytes by/date ____; test/check counts (total, completed, failed, skipped) ____; expected profile/check population ____.

**Expected result:** artifact → profile/input → exact checkout/overlay → actual exit code → retained log hash forms one unbroken, independently checked chain; the log belongs to this run and covers the agreed requirements. Missing, expired or mixed evidence is unresolved.

**Actual result:** ____ — **NOT EXECUTED**.

Evidence reference (supporting manifest/comparison) ____; tester (Code/name) ____; date ____; approval (reviewer decision/name/signature/date) ____.

## Before accepting a result

Check the SHA is the code actually executed, not just the PR head after later edits. Check the profile and fixture hashes match the command. Check the exit code came from the test command, not a later successful shell command. Recompute the retained log hash. Explain skips, empty collections, retries, overlays and missing logs; never turn them into completed checks.

Keep credentials, real records and private logs out of public artifacts. Register where authorised reviewers can retrieve evidence, its retention and any expiry ____; unresolved item/action owner/due date ____.

Builder 5: document-only template. No test, load, restore, production SQL, merge or message to John performed. Source/whitespace review only; operational results and approvals remain NOT EXECUTED/blank.
