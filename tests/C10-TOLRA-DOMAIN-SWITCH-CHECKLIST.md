# tolra.co.uk domain switch: check and record each result

Planning only; no DNS, hosting, provider or database settings changed here. Build/test deadline 6 November; target switch 12 November 2026. Rhys owns approval; Code operates; John checks workshop/office access. Every row starts **NOT RUN**. Record actual result, time, operator and private evidence per row. A blank/failed result stops the switch. Do not publish secrets, DNS account details or full auth links.

## Freeze the facts first

Record approved final full commit, Vercel project/deployment ID, current DNS zone/records/TTL, former destination, Supabase project reference, previous Site URL/allowed redirects, Microsoft/provider callbacks and rollback owner privately. Neither this repo nor its URL reveals the production Supabase project. Copy identifiers from the approved Operations Pack and dashboards, not from a guessed name. Save before-values before editing. Rehearse the list on a test domain first. Rhys chooses a switch window and a monitoring end time.

| Check (Code unless stated) | Expected result | Actual / evidence |
| --- | --- | --- |
| 01. Release readiness and backup/restore decision | Exact integrated commit independently approved; required CI/database/browser/manual evidence passes; recoverable backup proved; no outstanding release gate | NOT RUN |
| 02. Existing tolra.co.uk and www records, MX/TXT/CAA | Private before-snapshot includes all records and TTL; email/security records identified to preserve | NOT RUN |
| 03. Vercel project and Production deployment | Correct project, approved commit and Production environment; no Preview deployment promoted by mistake | NOT RUN |
| 04. Add apex and chosen www alias in Vercel | Dashboard shows intended project and exact DNS instructions for this project; no ownership conflict | NOT RUN |
| 05. DNS change, approved window only | Only agreed web records changed to the exact Vercel dashboard values; MX, SPF, DKIM, DMARC and unrelated records unchanged | NOT RUN |
| 06. Authoritative and independent public DNS checks after TTL | Apex and www resolve as Vercel instructed; no stale conflicting A/AAAA/CNAME; check IPv4/IPv6 where configured | NOT RUN |
| 07. Vercel domain status and HTTPS on apex/www | Both verified; trusted valid certificate covers requested host; no browser warning | NOT RUN |
| 08. HTTP/alias redirect | http apex/www and https www redirect to canonical https://tolra.co.uk, preserve path/query, no loop or unexpected host | NOT RUN |
| 09. Production NEXT_PUBLIC_SITE_URL | Exactly https://tolra.co.uk; correct Production scope; a rebuild/redeploy uses that value; confirm final deployment commit | NOT RUN |
| 10. Production Supabase URL/key pairing | NEXT_PUBLIC_SUPABASE_URL and public key belong to the approved same Supabase project; server credentials refer to that project; no preview/test backend | NOT RUN |
| 11. Supabase Auth Site URL | https://tolra.co.uk; before-value saved | NOT RUN |
| 12. Supabase allowed auth redirect URLs | Explicit https://tolra.co.uk/auth/set-password allowed; any other callback used by the app explicitly listed; no broad production wildcard or obsolete preview allow rule | NOT RUN |
| 13. Fresh sign-in, sign-out, MFA | Controlled JNR and second-company users reach only their company; MFA behaves as required; sign-out ends access | NOT RUN |
| 14. Controlled password-reset and invite emails | Real test recipient receives each; auth link resolves through the approved Supabase project to https://tolra.co.uk/auth/set-password; password set succeeds; used/expired links refuse | NOT RUN |
| 15. Microsoft 365 app registration and stored/env app credentials | Exact https://tolra.co.uk/api/integrations/microsoft/callback registered and used; reconnect under authorised test admin returns to canonical site, correct company mailbox only | NOT RUN |
| 16. Xero app registration and stored/env app credentials | Exact https://tolra.co.uk/api/integrations/xero/callback and https://tolra.co.uk/api/integrations/invite/callback registered; stored credentials and XERO_REDIRECT_URI consistent; controlled normal/invite callbacks succeed | NOT RUN |
| 17. Sage / QuickBooks if in approved release | Actual callback paths read from integrated provider config and registered exactly; controlled connection returns to right company; otherwise record excluded scope with approval | NOT RUN |
| 18. Controlled email proof (B5) | One message accepted and received with right sender, recipient, text and PDF; one matching history entry; draft/failed/unknown states never reported as received | NOT RUN |
| 19. Workshop and office smoke (John) | Real approved devices/network load correct JNR job, Hours and permitted office screens; permitted save survives reload once; no duplicate waiting entry | NOT RUN |
| 20. Access and origin checks | Other-company direct reads/writes refused, role matrix holds; same-origin change works, cross-origin change refused with no state change; no permissive CORS workaround | NOT RUN |
| 21. Assets, attachments and old links | CSS/JS/icons load over HTTPS; authorised files load, unauthorised access refuses; agreed old links land on correct canonical page without leaking login tokens | NOT RUN |
| 22. Monitoring after switch | Vercel errors, Supabase auth/database errors, OAuth and email checked through agreed period; no new unexplained failures; John confirms staff can work | NOT RUN |
| 23. Decision to finish | Rhys records PASS / HOLD / ROLLBACK with operator/checker, exact deployment and time; unresolved rows remain HOLD | NOT RUN |

Supabase API URL stays the approved project endpoint (normally https://<approved-project-ref>.supabase.co); changing the web domain does not rename it. A custom Supabase domain is outside this task. `NEXT_PUBLIC_SITE_URL` drives reset links and provider callbacks; stored provider redirect settings also need checking. Callback paths above come from `lib/auth-links.ts` and `lib/integrations/app-credentials.ts`. For Sage/QuickBooks consult the exact integrated `lib/integrations/accounting` provider config; do not guess callback paths.

## If a check fails

Keep writes/sends held if data, company access or duplicate actions are uncertain. Rhys decides whether to wait or reverse the web switch. Code restores recorded web DNS and Vercel mapping/compatible deployment as approved; restores Auth/provider URL settings only where required for that destination. Keep canonical auth/callback destinations consistent. Allow recorded TTL/cache time, then repeat DNS/TLS/sign-in/email checks on the restored destination. Tell staff to use paper while access is uncertain. A domain reversal does not undo data/schema writes: use D6 separately if those need recovery. Never run database rollback just to fix DNS.

Prepared 4 November 2026 by builder 4. Build and test deadline: Friday 6 November; go-live target: Thursday 12 November. This document does not approve a release. Practical rehearsal and named sign-off remain required.
