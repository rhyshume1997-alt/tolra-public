# Prove email works; use the existing manual fallback safely

John / office checks the message; Rhys/authorised admin checks the connection; Code supplies private provider evidence. Due 6 November on the approved rehearsal environment and controlled recipients. No live email was sent by builder 4. All proof results below are **NOT RUN**. No external customer test sends.

## What the app already does

`lib/email/send-company-email.ts` chooses a company's connected Microsoft 365 mailbox first, otherwise configured Resend (`RESEND_API_KEY` and `EMAIL_FROM`), otherwise saves a draft for Approvals. This selection is not an automatic retry through another provider after a send error. The mock provider is local/test-only and refused on Vercel. A saved draft means **nothing was sent**. Provider acceptance means the service accepted it, not proof it arrived.

## Connection and send proof

Record exact full commit/deployment, JNR and second fake company IDs privately, time, operator/checker, controlled recipient, document/history IDs and redacted provider evidence. Never log tokens or full auth links.

| Step | Expected result | Actual / evidence |
| --- | --- | --- |
| 1. Admin opens Integrations for JNR | Correct company; intended Microsoft mailbox connected, or Rhys confirms configured Resend sender; no test/mock mode on a deployment | NOT RUN |
| 2. Check callback/site settings | Approved canonical site and registered Microsoft callback agree; connection returns to same company; other-company/support user cannot connect as JNR | NOT RUN |
| 3. Office opens one fake document's Email action | Correct controlled recipient, sender/reply details, subject/body, amount/reference and right PDF; no unfilled placeholders | NOT RUN |
| 4. Send once and wait | Clear success or failure; record time and history ID; no repeated clicks | NOT RUN |
| 5. Check Email history and provider evidence | One matching company/document record with accepted/sent state and provider evidence; same-key replay does not send twice | NOT RUN |
| 6. Recipient checks inbox and junk | Actual arrival; sender/reply-to as intended; exact approved text and readable correct PDF; record message ID/time privately | NOT RUN |
| 7. Second company and roles | JNR cannot see/send second-company mail; workshop/viewer/support cannot bypass the sender permission; own office/admin permitted as defined by route | NOT RUN |
| 8. No-provider fake rehearsal | Approvals holds draft; user sees draft result; no provider delivery; manual path below works | NOT RUN |
| 9. Known failure, e.g. controlled provider refusal | Failed outcome recorded; no success claim; address/attachment/rate-limit error shown; only safe retry after cause corrected | NOT RUN |
| 10. Unknown outcome / lost response rehearsal | Hold visible; check provider/mailbox; no automatic/manual duplicate send; resolve only after confirmed outcome | NOT RUN |
| 11. Reopen/reload document and history | One consistent outcome and attachment evidence; no phantom second send; checker records PASS/HOLD | NOT RUN |

Steps 8–10 use controlled mocks/disposable fixtures, never break a real mailbox or revoke live credentials to simulate failure. Receipt proof in step 6 needs the real approved test mailbox; unit mocks do not satisfy it.

## Existing fallback: office sends through its normal mailbox

This is the existing Approvals/manual-mail path, not a new provider or automated feature. Rhys/John approve its use for the incident; record approver and time. Do not change provider settings to force a retry.

1. **First establish whether it went.** For “being sent”, “couldn't confirm”, unknown or a timeout, hold the document. An admin checks Email history, provider acceptance and the sender's Sent folder. If still uncertain, keep it on HOLD and contact Rhys. No manual send yet.
2. If definitely a draft/not sent, use **Approval Queue**: **Copy draft** (older screen: **Copy to Clipboard**) or open the draft in your mail app. For the document's existing **Open in my mail app** path, use that. Opening a mail window or copying text does not send it.
3. Check the recipient against the customer/supplier record. Download the right PDF from the document and attach it yourself; a mail-app link does not attach the PDF. Check subject, body, amount/reference, attachment and any agreed CC. Use JNR's approved mailbox, never a personal account.
4. Send once in that mailbox. Confirm it is in Sent and record message ID, time, sender and recipient privately. Check any bounce; a refused or uncertain send stays open. Tell the office who owns follow-up.
5. Only after actual manual sending, choose **Mark as Sent Manually** on the matching ordinary draft. Keep the matching document/history evidence. Do not use that control to settle an unknown system send or to claim delivery. Chase approvals have their own reviewed workflow: preserve approved text and hold unknown chase delivery; do not bypass that workflow using a generic draft button.
6. If Tolra cannot record the manual result, note it on the incident/paper register. After recovery the office checks mailbox/history before recording once. The checker reconciles every held item so an old draft cannot be sent a second time.

If no approved mailbox/PDF is available, phone the customer through the usual office process and agree follow-up. Keep the document unsent, with a named owner. Do not mark paid, alter totals or promise a sent message merely to clear a warning.

Source: `lib/email/send-company-email.ts`, `lib/email/markSentManually.ts`, `components/email/send-email-button.tsx`, `app/(dashboard)/approval/page.tsx`. Drafted, failed and unknown are different states; keep that distinction in staff messages.

Prepared 4 November 2026 by builder 4. Build and test deadline: Friday 6 November; go-live target: Thursday 12 November. This document does not approve a release. Practical rehearsal and named sign-off remain required.
