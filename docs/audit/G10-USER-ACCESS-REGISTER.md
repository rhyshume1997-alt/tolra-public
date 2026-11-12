# G10: JNR production user access register

Version 0.1 draft — 4 November 2026. Proposed owner ____; approved by ____; approval date ____; effective date ____.

**NOT EXECUTED.** This is a blank template, not a completed check. Leave unknown fields blank. Record facts and private evidence only after the work happens; do not infer a successful result. Keep completed copies in JNR’s approved private location, never this public repo.

Tolra supports JNR’s quality work. Software and documents cannot certify JNR; JNR is the company audited.

## Copy this record for each person

Requirement ID: G10-USER-____. Named user ____; job/duties ____; company/site ____; requested role ____; access needed until ____; MFA enrolled ____; enrolment evidence reference ____ (no recovery codes or secrets).

Expected result: only this approved person can use their own account, with the right JNR role and MFA where required; no access beyond their duties. Actual result ____ — **NOT EXECUTED**; evidence reference ____; tester ____; date ____; approval (approved by/name, decision, date) ____.

Departure/change review: still employed/authorised ____; checked against staff list by/date ____; departure or role-change date ____; access removed/changed by/date ____; old sessions checked ____; next review ____; deputy ____.

John approves business access; the authorised administrator applies it. Check the whole user list for leavers, spare accounts and unnecessary admin rights. Do not use shared logins or put passwords/MFA secrets in this register. “Enrolled” alone does not prove the sign-in rule is enforced.

## Negative checks — use approved test accounts, never another person’s password

For each check, name the tested user/role in its private evidence. Arrange checks with Rhys; do not change production permissions just to complete this form. Stop and report unexpected access.

| Requirement ID | Expected result | Actual result | Evidence reference | Tester | Date | Approval |
| --- | --- | --- | --- | --- | --- | --- |
| G10-NEG-01 | Unauthorised role cannot open admin user/settings controls or approve actions outside its role. | ____ (NOT EXECUTED) | ____ | ____ | ____ | ____ |
| G10-NEG-02 | A user cannot view another company’s records, including a copied record link. | ____ (NOT EXECUTED) | ____ | ____ | ____ | ____ |
| G10-NEG-03 | A removed/departed account and its old session cannot continue using JNR records. | ____ (NOT EXECUTED) | ____ | ____ | ____ | ____ |
| G10-NEG-04 | Required MFA cannot be bypassed on a fresh sign-in; recovery follows the approved process. | ____ (NOT EXECUTED) | ____ | ____ | ____ | ____ |

Sources: [company-role rules](https://github.com/rhyshume1997-alt/tolra-public/blob/68f89ca7b801a10587ff9b51d6c820462847b65a/lib/company-access.ts); [inspector authority](https://github.com/rhyshume1997-alt/tolra-public/blob/68f89ca7b801a10587ff9b51d6c820462847b65a/lib/inspectors.ts). These source files do not prove JNR’s actual access list or MFA state.

Prepared by builder 5 under Rhys’s explicit document-only assignment. Source review and whitespace check only. No live check, production SQL, real data or message to John. Technical source snapshot: `68f89ca7b801a10587ff9b51d6c820462847b65a`; confirm the installed release before use.
