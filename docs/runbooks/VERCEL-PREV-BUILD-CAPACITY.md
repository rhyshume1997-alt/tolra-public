# VERCEL-PREV — keep enough build capacity for Tolra

Rhys: __________ Date: __________. Vercel is the service which builds and runs the website. A preview is a separate copy made for a branch. Too many preview builds can use up the allowance or delay the real release.

Choose: [ ] The current eligible plan has enough capacity [ ] Stop automatic branch preview builds.
**Either choice needs evidence.** This does not authorise a production deployment or a paid upgrade. Do not turn off required code checks. If a label below has changed, find the current equivalent with technical support; do not guess.

| Tick | Step | What he should see | Stop if… |
| --- | --- | --- | --- |
| [ ] | In Vercel, compare the team, project and production domain with the private go-live record. | All three identify the intended Tolra site. | Any name/domain differs. |
| [ ] | Read the plan's current commercial-use terms, remaining build allowance, usage limits and build queue. | A plan eligible for this business, with capacity for the agreed release and a recovery build. | The plan is personal/non-commercial only, capacity is unknown or payment needs approval. |
| [ ] | If keeping previews, write down the plan, remaining allowance, queue length, expected release needs and the person who will watch them on cutover day. | Actual dashboard evidence supports keeping previews. This route finishes here with the sign-off below. | The allowance or queue leaves release/recovery uncertain; use the other route or seek a plan decision. |
| [ ] | If stopping previews, open project Settings → Git (or the current build controls). Save the current settings privately before changing anything. Ask technical support to check existing ignored-build rules. | The old settings can be restored exactly. | There is existing custom logic nobody understands. Do not replace it blindly. |
| [ ] | Confirm Vercel's `VERCEL_ENV` system variable is available to the ignored-build command, with the documented values for production and preview. | The production build receives `production`; a preview receives `preview`. | The variable is absent/unknown. The example below would otherwise skip production too. |
| [ ] | Rhys applies the reviewed preview control. If using Ignored Build Step, use the exact command below after the previous checks. | Exit 0 means “skip”; exit 1 means “build”. Production is allowed, other branch builds are skipped. | The dashboard describes different exit meanings or the command would replace required custom rules. |
| [ ] | With an approved harmless test branch, check a new automatic preview attempt. Check the release settings still allow the intended production branch. | The preview build is ignored/skipped; production is permitted by the rule. A cancelled/ignored deployment entry may still appear. | A full preview builds, or production is excluded. Restore the recorded setting with the owner and investigate. |
| [ ] | At the next separately authorised production deployment, watch the real build. | It builds and reaches the normal successful state. Record that evidence separately. | It is skipped or fails. Stop the release; do not keep changing controls until something happens. |

Reviewed Ignored Build Step example (only after the checks above):

```sh
if [ "$VERCEL_ENV" = "production" ]; then
  exit 1
fi
exit 0
```

Plan/capacity evidence: __________. Before-setting record: __________.
Preview test result/time: __________. Production build proof: __________ / [ ] Not yet run.
Rhys signature: __________. Technical reviewer: __________.

## Handover

Documentation only; no Vercel settings, subscription or deployments changed. Current repository `vercel.json` has no preview-disable setting. Dashboard labels and allowances must be checked on the day. The rule above keeps production eligible; it does not prove an actual production deployment has run.

Related sheets named here may still be separate draft PRs. Use their reviewed versions from the agreed cutover pack; a draft title is not approval.
