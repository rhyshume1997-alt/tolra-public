# G18 evidence provenance verifier and remaining map

Reviewed public delivery-note candidate `31f965e7f0cbb2d9caf336b0a2067411bec8fb45`. This is a pinned read-only checkout of #359; Claude Code’s branch and its owned test files were not edited. New tests have unique `b5-` names. No ISO packs started. No production URL/key, production SQL/wipe/import/counter action, main merge, deployment, live AI or automated email was used. John was not contacted.

Evidence directories keep original logs (including initial failures), UTC times, exit codes, environment/source commit and SHA-256 SQL-input manifests. Counter SQL additionally records each actual statement hash, exit/time/output and a nonce/container identity receipt. Scope limits below are part of each verdict; no skipped/blocked runtime check is a pass.

G18: offline verifier and adversarial review done; 14 named verifier tests passed. Actual Code artifact map across `prod`, `realistic`, `x100` remains **NOT VERIFIED**; no artifact IDs/log hashes/exit codes were invented.

`scripts/reviewer-evidence/verify-provenance.mjs` accepts manifests and an exact expected checkout SHA. It requires unique artifact IDs, all three profiles, an explicit synthetic-only declaration, matching checkout/executed SHA, actual exit 0, a named environment, SQL hash, ordered UTC times, nonempty all-complete results, zero failed/skipped/todo, disposable identity fields and a retained log whose SHA-256 matches the bytes read. It never executes a command or connects to a database. Profile `prod` means synthetic production-shaped data, not production access.

Run offline from the evidence directory using the committed verifier, a JSON array manifest and expected 40-character SHA. Each array item needs: `artifact_id`, `profile`, `synthetic_only`, `checkout_sha`, `executed_sha`, `exit_code`, `environment`, `sql_sha256` (digest of the actual SQL-input manifest/bytes, as declared), `start_utc`, `end_utc`, `total`, `passed`, `failed`, `skipped`, `todo`, `identity` (`kind: disposable`, creation nonce, 64-hex image digest and container ID), `log_path`, `log_sha256`. Do not put keys or record values in this manifest.

The 14 tests cover a good synthetic chain and wrong checkout/executed heads, nonzero exit, missing profile, zero/skipped tests, missing SQL hash, localhost-only identity, real-data declaration, absent artifact ID, changed/missing logs and reversed time. These fixture manifests are unit data, **not** completed Code profile evidence. The earlier Node --test wrapper reported only file-level count 1; the direct named run is the authoritative 14-case count, and both logs remain.

Limits: this tool checks the supplied metadata and retained bytes. It cannot prove a claimed exit code was captured from the correct process, that a copied log is genuine, or that the identity nonce actually came from a new container. Code must bind each manifest to an independently retained execution/identity journal. A good hash proves byte identity, not truth. No actual external profile manifest/log population was supplied.

Own overnight runs record source commit `31f965e7f0cbb2d9caf336b0a2067411bec8fb45`, environment, UTC start/end, exit code, SQL-input manifest hash and original-log SHA-256. Counter SQL adds a per-statement journal and external nonce/container receipt before writes. Original setup/readiness/network failures are retained; no rerun overwrites them. Initial CLI/Docker diagnostics before the recorder were not counted as completed gap proof. For actual Code evidence, fill the existing G18 template (#370) and independently check the full chain; do not reuse a workflow branch’s SHA as the app checkout without evidence.

## Exact committed-code rerun

Executed checkout `9d580c6dafc26a31df35c1f4aaf6eea6ec7e1946`; UTC 2026-11-04T21:57:40.488542+00:00; exit 0; duration 0.215 seconds. Full environment, SQL manifest/log hashes and command file hashes are in `evidence/2026-11-04T21-57-40.488542+00-00-committed-provenance-443d3a/run.json`; original log bytes retained. This supersedes contextual checkout ambiguity for earlier uncommitted test overlays. Later commits only attach review/evidence.

Fourteen named offline verifier tests passed; actual Code profiles remain unverified.
