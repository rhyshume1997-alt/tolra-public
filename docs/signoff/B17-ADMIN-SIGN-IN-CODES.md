# Make every admin use an authenticator code

Rhys and the authorised technical person carry this out; John checks the result. An authenticator is a phone app that makes sign-in codes. Do not share its codes or setup secrets.

Company/system/version being checked: ____. Working admin and cover: ____.

**Two protections must be on:** the live website must require admin codes, and the company's database must require them too. Setting up a phone app alone is not enough. The technical person's exact setting names are below; John does not need to change them.

| Tick | Action | What John should see |
| --- | --- | --- |
| [ ] | After agreeing the B15 access list, technical person checks the correct Supabase system supports authenticator codes and the named recovery/cover admin works. | Correct company/system, tested cover. STOP if recovery is unknown. Do not rely on the account being removed. |
| [ ] | Every active admin, including a person with admin as their second role, sets up and verifies their own app and tries a fresh sign-in. | **Admin → Users** says **Two-step sign-in: set up** for every admin. Each can complete the code challenge. |
| [ ] | Read the company overview in **Admin → Users**. | **Every admin has set up two-step sign-in, so it can be required for this company.** Missing/unknown status means STOP. |
| [ ] | Technical person turns on the company's database rule using the separately approved procedure, then checks the result. | **The company requires two-step sign-in for admins. Every admin has set it up.** A refusal is a stop, not permission to bypass it. |
| [ ] | Under separate release approval, Rhys/technical person turns on the live website requirement and publishes the approved version using it. | The actual live version uses the setting. Changing only a practice setting or an unpublished value does not count. |
| [ ] | On the practice system, try an admin login and a second-role-admin login. Technical person tries protected pages and a safe admin action directly before entering a code. | Access/change refuses before the code, then works after a valid code. Keep both results. |
| [ ] | Try a wrong/expired code, then the correct one. After 15 minutes, try a sensitive admin change using the old session. | Bad codes refuse; current code works. Sensitive changes require a recent code, even with an old session still open. |
| [ ] | Check normal office/workshop/look-only work, both protection settings and the working cover again. | Normal permitted work remains, no extra admin power, both protections still on. |

Lost phone/app: verify the person's identity and use the agreed recovery process. Do not routinely turn protection off to get past a problem. Rehearse failure/recovery with fake accounts; live actions need separate approval.

**For the technical person:** Vercel **Production** `REQUIRE_ADMIN_MFA=true`, on the actual approved deployment; each included company's database `require_admin_mfa=true`. The company database rule is not an ordinary staff-screen switch. Keep the approved procedure and target checks; this sheet is not permission to run production SQL.

Result: [ ] COMPLETE [ ] FAILED [ ] NOT RUN. Version/deployment, time and saved results: ____.

John understands handover, signature/date: ____  Rhys approves scope, signature/date: ____

Technical person/checker signatures/date: ____

Blank master, prepared 4 November 2026. Complete/sign a private copy. Empty boxes are not approval; this writing job performed none of the actions above.
