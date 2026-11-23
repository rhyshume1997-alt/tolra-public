<!--
BOUNDARY: documentation only. Inputs: the switches as they exist on main and the open PRs listed below (as read from GitHub). Outputs: a
checklist for turning each switch on. It changes no code, no flag and no company setting. Do not treat it as approval to turn anything on.
Keep it in step with docs/MODULES.md. PR states were read from GitHub on 2026-11-18; re-check them before relying on this.
-->

# Flag rollout checklist

Every switch below is OFF by default. Nothing is turned on by this document. Turning one on is a separate, explicit step that needs the approval named under it.

Approver: "Rhys" is the project owner and PM named in `docs/release/KNOWN-LIMITATIONS-AND-RECOVERY.md`. Where a company switch is involved, the company's own admin flips it, but only after Rhys's approval.

Common steps for every flag (do not skip):

1. The listed PRs are merged to `main` and CI is green on `main`.
2. Preview deployment built from that `main`, with the company switch OFF first, then ON for one test company only.
3. Rhys approves in writing (PR comment or message) naming the flag and the company.
4. Turn it on for one company, check, then widen. Turning it off again is the rollback.

---

## 1. Reports (operations reports, module 7)

- **Current state:** OFF. Per-company marker `reports:on` in `organization_settings.hidden_nav`; absent means off (`lib/reports/reports-switch.ts`). Admin and office only.
- **PRs that must merge first:** none outstanding. [#544](https://github.com/rhyshume1997-alt/tolra-public/pull/544) (Retry on Reports and Revenue, Revenue link, browser acceptance spec) is merged (2026-11-17). Also on main: #483 (reports), #490 (access gate), #501 (menu link), #503 (settings switch).
- **Check on Preview:**
  - Switch OFF: `/reports` shows "Reports are switched off for your company." and no report data loads; the menu link is hidden.
  - Switch ON: admin and office see the page; workshop and viewer are redirected to `/dashboard`.
  - No costs are shown anywhere; figures match the Jobs pages for the same job.
  - Retry works after a forced load failure.
  - `tests/e2e/reports.spec.ts` passes against the Preview.
- **Approve before on:** Rhys.

## 2. Revenue (reports, module 7)

- **Current state:** OFF. Per-company marker `reports-revenue:on` in `hidden_nav` (`lib/reports/revenue/revenue-switch.ts`). Admin and office only. Separate from the Reports switch.
- **PRs that must merge first:** none outstanding. [#544](https://github.com/rhyshume1997-alt/tolra-public/pull/544) (adds the Revenue link and the acceptance spec) is merged. Reports (section 1) should be proven first because Revenue is reached from the same area.
- **Check on Preview:**
  - Switch OFF: "Revenue reports are switched off for your company."
  - Invoiced basis and cash basis are shown separately and never added together; quote pipeline is never counted as revenue.
  - A person with the "invoices" section hidden sees the "Invoices are hidden" notice, never a 0 figure.
  - Totals agree with the invoice list and payments for a test company, to the penny.
  - `tests/e2e/revenue.spec.ts` passes against the Preview.
- **Approve before on:** Rhys. Because these are money figures, also ask the company's accountant or finance owner to sign off the first run.

## 3. ISO templates (module 9)

- **Current state:** OFF. Per-company marker `iso-templates:on` in `hidden_nav` (`lib/iso/iso-switch.ts`). Admin only.
- **PRs that must merge first:** none outstanding. [#545](https://github.com/rhyshume1997-alt/tolra-public/pull/545) (on/off switch and "Records present" wording, consolidating #511 and #514) is merged (2026-11-17). #511, #514 and #512 are still open drafts that #545 supersedes; they are not needed and should be closed unmerged by Rhys. On main the switch card is rendered from `components/iso/iso-pack-view.tsx`, so #512 (Settings mount) is not required for the switch to have a screen; confirm this on Preview.
- **Check on Preview:**
  - Switch OFF: the ISO page shows the off notice.
  - Switch ON: admin only; office, workshop and viewer cannot open it.
  - The gap checklist says "Records present", not a bare "Met".
  - Downloads are draft templates; each carries the wording that it needs company review and is not certification evidence.
  - No AI, no saved documents.
  - `tests/e2e/iso-templates.spec.ts` passes against the Preview.
- **Approve before on:** Rhys (wording of the checklist and templates is customer-facing).

## 4. Customer portal (module 10)

- **Current state:** OFF at two levels. The server flag `CUSTOMER_PORTAL_ENABLED` must be exactly `"true"` (unset is off; `lib/portal/flag.ts`). The company switch (release 154 functions, off by default) must also be on. Both are enforced on the server.
- **PRs that must merge first:**
  - [#546](https://github.com/rhyshume1997-alt/tolra-public/pull/546) (staff admin, release 154 database proofs, browser acceptance) is merged (2026-11-18), as is #500 (staff administration, unmounted). Nothing further needed from these.
  - [#526](https://github.com/rhyshume1997-alt/tolra-public/pull/526) (mounts Portal contacts on a saved customer, module 5), so staff can invite someone. Still an open draft, and its base is `feat/portal-staff` (already merged via #500), so it needs retargeting to `main` before it can land. Portal contacts are not mounted on Customers on main yet.
  - [#528](https://github.com/rhyshume1997-alt/tolra-public/pull/528) (browser acceptance) is an open draft already included in #546; it does not need to merge separately.
  - [#527](https://github.com/rhyshume1997-alt/tolra-public/pull/527) (browser acceptance of the Customers contacts mount, open draft) comes after #526, not before.
  - Release 154 (`supabase/release/154_customer_portal_signin.release.sql`) applied to the database. Migrations need explicit release approval; this document does not authorise it.
  - Already on main: #495, #498, #499, #505, #520.
- **Check on Preview:**
  - Server flag unset: every portal route refuses with the single generic refusal.
  - Server flag `"true"` but company switch off: still refused, and the refusal does not say whether the contact, code or company exists.
  - Both on, one test company: a contact is invited, receives the sign-in e-mail from the platform's verified Resend sender (`EMAIL_FROM`, not a company mailbox), signs in, sees only their own quotes and jobs, signs out.
  - Wrong code, reused code and rate-limit boundaries all give the same generic refusal.
  - No e-mail address, name, IP, code, ref or token appears in logs or audit rows; the customer never sees `sends` or `email`.
  - `middleware.ts` is unchanged by this rollout (it belongs to module 1).
- **Approve before on:** Rhys for the platform flag on Vercel (Preview first, then Production) and for the company switch.

## 5. Accounting transfers (Xero; module 6)

- **Current state:** OFF per company. The Xero transfer switch is `xero_transfer_hold.enabled`, created by release 149 with every existing company set to `false` ("installed off"). The app treats a missing function, row or read error as OFF (`lib/integrations/xero/launch-hold.ts`). Sage and QuickBooks offer connections and read-only invoice checks only; they do not send.
- **PRs that must merge first:** no PR is a hard prerequisite. #510 is not enough on its own to turn this on. Release 149 is already in the repo, but it must be confirmed applied to the target database (the release preflight rows say so). [#510](https://github.com/rhyshume1997-alt/tolra-public/pull/510) (open draft) only adds browser acceptance for Xero organisation confirmation. Turning transfers on also depends on the Preview checks below, the NOT VERIFIED switch-off rules being checked, and Rhys's approval. The Sage and QuickBooks PRs ([#518](https://github.com/rhyshume1997-alt/tolra-public/pull/518), [#523](https://github.com/rhyshume1997-alt/tolra-public/pull/523), [#524](https://github.com/rhyshume1997-alt/tolra-public/pull/524)) are not needed for Xero transfers. They are all open drafts (#523 is stacked on #518); keep them out of this rollout unless Rhys says otherwise. [#517](https://github.com/rhyshume1997-alt/tolra-public/pull/517) is "DO NOT MERGE" (open draft).
- **Check on Preview:**
  - Switch OFF: nothing is sent or retried; the message "Xero transfers are off for this company" shows.
  - Turning ON needs the company's second sign-in step on and an authenticator code from the last 15 minutes (release 149).
  - Mapping shows "Mapped" (no outstanding accounts or tax rates) for the test company.
  - Use a Xero demo organisation, not a live one. Send one invoice and confirm the Xero record matches the Tolra invoice (contact, lines, VAT, total).
  - Switch OFF in the middle of a send: the next provider call is not made and the row goes back to pending.
  - Known gap: the exact switch-off rules (including whether a fresh code is needed) are marked NOT VERIFIED in `docs/release/KNOWN-LIMITATIONS-AND-RECOVERY.md`; check the function before relying on it.
- **Approve before on:** Rhys, separately for each company. Do not turn it on "to test" on a live company. Rolling back release 149 itself also needs Rhys's separate approval.

## 6. Tooly tours (module 11)

- **Current state:** OFF. Two switches, both needed: the server env flag `TOOLY_ADMIN_TOUR_ENABLED` (exactly "true"; one flag for all three views) and one per-company marker in `hidden_nav` for each view: `tooly-admin-tour:on`, `tooly-office-tour:on`, `tooly-workshop-tour:on` (`components/tooly/tour/tour-switch.ts`). A marker switches on only its own view, so a company that has the admin tour on does not get the other two. A viewer never gets a tour. There is no Settings screen for the markers yet.
- **What it is:** a fixed script of plain-words steps (admin 23, office 17, workshop 13) that points at screens and never clicks, saves or sends. No AI, no keys, no new table. It opens by itself the first time a person signs in. Each step has a note ("What happens here and how it gets produced") they can open. A person who skips or finishes it is not shown it again (the saved flag in `lib/auth/tour-flag.ts`), and can replay it from a small button on the Dashboard.
- **Check on Preview:**
  - Env flag unset or no marker: nothing shows for anyone.
  - Env flag on and one marker: only that view sees its tour; the other two do not.
  - Office and workshop: a page switched off for the person (Admin > Users > Page access, or the company menu) is skipped or named as off, never walked to.
  - Skip tour, then reload: the tour does not come back, and a Replay tour button shows on the Dashboard (only there). Replay starts at step 1.
  - Open the note on a step: it explains the step and closes again on the next step.
- **Game look:** a third, separate company marker `tooly-game-tour:on` switches the full-screen look on (dimmed page, spotlight, Tooly and a speech bubble). It does not make a tour appear on its own. Check on Preview with the env flag, a view marker and this marker: the page is dimmed and a click on it does nothing, the spotlight follows each step, the bubble moves clear of the thing pointed at, Skip tour and Replay still work, and with the marker removed the small card comes back.
- **Approve before on:** Rhys (the wording is staff-facing, and turning it on is a Vercel env change plus a company setting).

## 7. Owner console: Companies (module 15)

- **Current state:** OFF. One server flag, `PLATFORM_COMPANIES_ENABLED` (exactly "true"); with it off the two routes answer 404 (to a platform owner; anyone else is refused by the owner guard first) and the panel renders nothing. Platform owners only (the existing `/platform` guard).
- **What it is:** a Companies card on `/platform`: every company with its people, jobs and invoices (issued ones separately), and Close or Reopen per company. Close needs the company's exact name typed, a reason and an authenticator code under 15 minutes old, and is refused for the company the owner is inside. Nothing is deleted; Reopen undoes a Close.
- **Needs:** release 164 applied on that database (the panel shows "Couldn't load the company counts" until it is). Applying 164 on production needs Rhys's yes on the exact file after a fresh backup.
- **Check on Preview:** flag unset: nothing shows and `/api/platform/companies` answers 404. Flag on, signed in as a platform owner at the second step: counts are right; Close with a wrong name is refused; Close then Reopen round-trips; a company admin cannot call either route.
- **Approve before on:** Rhys (Close locks a live company's staff out at once).

---

## Not covered

- AI helper, AI assistant, AI finance check, e-mail and Microsoft 365 switches are also off by default but were not in the request. [#551](https://github.com/rhyshume1997-alt/tolra-public/pull/551) (Tooly Step 2: Tooly as the AI helper face) is open (not draft, not merged) as of 2026-11-18; it has no checklist here.
- This list was built from the repo and PR titles and states read from GitHub. PR contents were not reviewed, so "must merge first" is the best reading of the titles and stacking notes. Rhys should confirm it before anyone relies on it.
