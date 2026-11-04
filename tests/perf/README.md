# Measure page loading on a test system

Use the same computer, browser, role, fake company, row counts, build mode and backend for before and after. Keep the terminal table with the exact code SHA (`git rev-parse HEAD`). This script does not build, seed, sign in or change a database. Never point it at production, or a local app configured to use a production backend.

1. Start the approved test app and disposable backend using the existing E2E instructions; keep them running. A production build avoids Next dev compilation noise.
2. If needed, save an authenticated **test** browser storage-state file outside git, using your normal Playwright login setup. Choose an admin/office test account that can see all four pages. Login/MFA redirects fail the run. Treat that session file as a secret.
3. From the repo root, after `npm ci`, run:

```sh
node tests/perf/page-timings.mjs --base-url http://localhost:3001 --storage-state /private/test-session.json
```

Use `--executable-path /usr/bin/chromium` if using a system browser instead of `npx playwright install chromium`. For a separately verified remote **test** installation, add `--test-origin https://your-test-host.example` and use the same origin in `--base-url`. This explicit flag does not prove its backend is disposable; check the app configuration first. There is no automatic CI job and no production run.

The table shows dashboard `/dashboard`, jobs `/jobs`, timesheets `/time` (heading “Weekly hours”), and customers `/customers`. Each has five cold and five warm full-document navigations, median, slowest and all samples in milliseconds. Cold means a fresh browser context each time, with the same supplied login state and empty HTTP cache. Warm means one fresh context, one untimed priming load for that route, then five measured navigations in that context. Warm is browser cache reuse; this does not measure client-side link navigation. Service workers are blocked for both modes. Server/database/CDN caches are not cleared: “cold” refers only to the browser context.

Timing starts immediately before navigation and ends after the correct heading, a 500 ms network-quiet window, no visible loading/skeleton elements and two animation frames. That is a repeatable loading proxy, not proof every figure is correct or a Web Vitals score. Loading failures, wrong routes, HTTP errors and timeouts print FAIL and exit nonzero; partial runs never get a median. The default timeout is 30 seconds per step (`--timeout-ms`). Compare all eight rows; do not call one faster sample a measured improvement. High background traffic can make network-quiet time out.

Builder 6 validation and remaining work are in `docs/handover/BUILDER-6-L2.md`.
