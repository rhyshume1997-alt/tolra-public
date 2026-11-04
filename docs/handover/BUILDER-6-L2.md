# L2 — page timing tool and handover

Builder 6, 4 November 2026. Explicit L2 assignment; atomic `claims/L2`. Independent draft based on `9c3f5c6`, targeting `codex/b4-lag-review` (the same pinned review base as #343/#344). No app/package/CI configuration changed. Read AGENTS.md plus the handover/ownership records at `d7596ca`; no Next API changed.

Deliverables: `tests/perf/page-timings.mjs` and `tests/perf/README.md`. Run from repo root:

```sh
node tests/perf/page-timings.mjs --base-url http://localhost:3001 --storage-state /private/test-session.json
```

The guide describes test setup, browser installation/selection, optional approved remote test origin, role/session, timing endpoint, cold/warm meanings, limits and how to save comparable before/after results. The script prints eight rows: four actual routes, five cold and five warm measured navigations each, median/slowest/raw samples. One untimed priming load per warm route; fresh context per cold run. Authentication redirects and error/unfinished screens fail, with no misleading partial median. Includes a documented 500 ms quiet window; this is a repeatable loading proxy, not page correctness or Web Vitals. No files containing browser login state or credentials were created/committed.

## Checks actually run

- `node --check tests/perf/page-timings.mjs`, `--help`, explicit unchanged-config ESLint: pass.
- System Chromium `/usr/bin/chromium` against a task-owned **loopback HTTP fixture only** at `127.0.0.1:4316`: **all eight rows had five samples and numeric medians/slowest values**, exit 0. Fixture had the real route headings, delayed fetch and visible loading text that disappeared. Correct jobs heading is “Job Board”; source review caught and corrected the initial “Jobs” test heading before this final run.
- Final fixture medians/slowest (ms): dashboard cold 709/734, warm 633/666; jobs cold 665/693, warm 633/634; timesheets cold 687/745, warm 633/635; customers cold 701/725, warm 633/634. **These are fixture/tool checks, not Tolra performance numbers or a before/after claim.**
- Separate loopback fixture at `127.0.0.1:4317` redirected routes to login: all eight rows printed FAIL with zero completed samples and exit 1, as required. Timeout reduced to 1,000 ms for that deliberate refusal check.
- Whitespace check: pass. Fixture sources stayed in workspace scratch, outside the PR; no database, app login, production URL or production SQL was used.

## Remaining work

No configured authenticated Tolra test app/backend was available for this job; actual application timings remain NOT MEASURED. Rhys/CI should run the tool on the approved test server before and after changes, keeping build mode, exact SHA, role, fake data volume, machine and backend stable. Confirm a local app also uses a disposable backend. No production run, deployment, main merge, Ready label or automatic CI workload was added. This handover and the tool are committed before publishing the draft.
