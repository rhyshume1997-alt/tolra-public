# Make every admin use their sign-in code

For Rhys and the authorised technical operator, with John checking the result. A code comes from an authenticator app; it is not a password emailed by support. This sheet changes no settings itself.

**Two separate switches are needed:** Vercel Production `REQUIRE_ADMIN_MFA=true` and each included company's database rule `require_admin_mfa=true`. Enrolling an authenticator alone does not turn both rules on. The database rule has no ordinary staff-screen toggle; the operator must use the separately approved release/operating procedure. This job gives no production SQL instruction or permission.

Company/project scope and frozen version: ____. Named current/cover admins: ____.

| Tick | Step | What he should see |
| --- | --- | --- |
| [ ] | After B15's access list is agreed, verify the intended Supabase project has authenticator/TOTP available and the recovery plan names a working second admin/operator. | Correct project; recovery cover tested. Nobody relies on the login being removed. STOP if recovery is unknown. |
| [ ] | Every active admin, including anyone with admin as second role, signs in with their own account and enrols/verifies their authenticator. | **Admin → Users** shows **Two-step sign-in: set up** for each. Each can complete a fresh code challenge. Never copy codes/seeds into this sheet. |
| [ ] | Read the company's overview in Admin → Users. | **Every admin has set up two-step sign-in, so it can be required for this company.** A missing/unknown admin or unavailable overview means STOP. |
| [ ] | Operator applies the separately approved company database rule for the listed companies only; verify its real result. | **The company requires two-step sign-in for admins. Every admin has set it up.** A guard refusal is a stop, not a reason to bypass it. |
| [ ] | Rhys/operator sets Vercel **Production** `REQUIRE_ADMIN_MFA` to `true`, rebuilds/deploys only under separate release approval and records the actual deployment. | Approved Production deployment uses true; setting Preview only, or changing a value without deploying it, does not complete this step. |
| [ ] | On the rehearsal system, use fresh admin/second-role-admin sessions and type a protected URL directly before entering the code. Try an authorised safe API/database admin action. | No access/change until the code is verified; then the same permitted action succeeds. Preserve evidence of both outcomes. |
| [ ] | Try wrong/expired code, then the correct current code. Try a sensitive admin change after the recent-code window. | Wrong/expired code refuses; correct code works; sensitive changes ask for a recent code (15-minute rule), including when an old login is still open. |
| [ ] | Check office/workshop/viewer behaviour and the retained replacement/cover admin. Recheck both switches and company overview after reload. | Their permitted roles still work, no extra admin rights, cover works, both rules stay on. No global-off workaround left behind. |

Recover a lost authenticator only after identity checking through the existing approved recovery procedure. Do not routinely switch protection off to get past a failure. Rehearse failure/recovery with fake accounts; live checks need their separate authority.

Result: [ ] COMPLETE [ ] FAILED [ ] NOT RUN. Exact version/deployment, evidence, time: ____.

John understands handover, name/signature/date: ____

Rhys approves scope, name/signature/date: ____  Operator/checker signatures/date: ____

Blank master, prepared 4 November 2026. Fill and sign a private copy. An empty box is not approval. Keep phone numbers, customer records, keys and signatures out of the public repository.
