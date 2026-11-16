# #396 required CI: exact failure

Public PR head: `638a12c5fcd494597e1e99da95d77bb430256195`.
[Run 41986450659](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41986450659), failed job **ci-gate 127110173148**. Full original decoded log is retained in evidence/xero396/ci-gate.log.

Actual log lines:

```text
2026-11-05T07:24:54.5339996Z event=pull_request ready=false changes=success code=true integration_needed=true
2026-11-05T07:24:54.5341092Z web=success integration=skipped
2026-11-05T07:24:54.5342924Z WAITING: code changed but the full integration suite hasn't run. Add the ready label to run it; this check passes once it does.
2026-11-05T07:24:54.5361717Z ##[error]Process completed with exit code 1.
```

**Cause: the required integration suite was not started because the PR has no ready label.** `.github/workflows/ci.yml` lines 134–136 gates integration on ready; lines 280–284 deliberately fail the required gate for a code change with integration skipped and ready=false. Web succeeded; the job metadata independently agrees.

This is **not an Xero regression and not an environment/resource limit**. There is no environment-limit log line to cite for this run. It is also not a green integration result: no database/browser integration tests ran in this job. #396's 233 local mocked tests, TypeScript and lint remain their own evidence.

No app fix or workflow change is justified by this log. Full required integration remains **UNPROVEN**, pending the normal ready/review process and an actual passing run at the final SHA. No ready label, rerun, dispatch, merge or bypass was applied in this diagnosis. Earlier local inability to download runner logs was an access limitation of that client, not the cause of this CI failure; the GitHub connector obtained the original log here.

Checks: source and original log read only; 0 new tests run. One integration job was skipped in the observed workflow; no invented skipped-test count. No production SQL, real data, private files, John messages or #359/go-live changes.
