# G20 — External services register

Draft 0.1 | Register owner ____ | Final release SHA ____ | Review date ____.

**NOT EXECUTED. Actual launch settings are NOT VERIFIED.** The states below are proposals for Rhys to decide, not claims about a live company. A service being built or having no key in this checkout does not prove it is off. No connection, email, export or provider call was made for this register.

| Requirement / service | Owner (person) | Data that may leave Tolra or SliQ | Proposed launch state — needs approval | If it fails |
| --- | --- | --- | --- | --- |
| G20-XERO — Xero | ____ | Customer/account details, invoice/credit values and tax, references and linked accounting records | **OFF**: no automatic send or sync until scoped connection and approval are checked | Keep Tolra records; finance reconciles a reviewed manual export. Check remote state before retrying to avoid duplicates |
| G20-M365 — Microsoft 365 | ____ | Permitted mailbox addresses, message text, attachments and message IDs; sending and inbox access need separate decisions | **OFF**: automatic mailbox polling/sending held. Manual company-mail use needs its own signed decision | Use the agreed office mailbox process. Record the message/reference in Tolra; check Sent Items before retry |
| G20-EMAIL — Email delivery (Microsoft Graph or Resend, as configured) | ____ | Recipient addresses, approved message text, invoice/delivery attachments and delivery status | **OFF for automated mail**. Manual approved sends: decision ____ | Keep the draft and tell the office owner. Check provider acceptance/Sent Items; an uncertain send is not permission to resend |
| G20-AI — AI provider (Anthropic in reviewed code) | ____ | Selected RFQ/work text or masked summary/assistant context; provider authentication and usage metadata | **OFF**, company and server switches; no live keys until approved. £5 cap issue in #375/#381 is unresolved | Use the normal forms by hand. Do not send the task elsewhere or increase a cap to bypass refusal |
| G20-SLIQ — SliQ file export/archive (manual files, not a live Tolra sync) | ____ | Approved customer/supplier/invoice/payment files from SliQ into the controlled archive/load process | **Manual approved export only**; import/write actions held until separately approved | Keep SliQ available read-only under the agreed plan; retrieve excluded records there and record the source reference |

Microsoft 365 and the email row can use the same provider; approve permissions and sends once and cross-reference them. Do not create a second sender accidentally. The exact provider/account/mailbox, allowed fields, access scopes, company, schedules, retention and fallback owner must be recorded privately. Never put credentials or real records here.

## Complete one verification record for each row

Requirement ID ____; service/account reference (no secret) ____; company ____; owner ____.

Expected result: approved launch state and permissions match the exact release; a disabled service makes no network/send/sync call; the fallback avoids duplicates and preserves records.

Approved OFF/ON/manual-only decision ____; approver/date ____; observed company/server switch, connection and schedule state ____.

**Actual result:** ____ — **NOT EXECUTED**. Evidence reference ____; tester ____; date ____; independent approval/signature/date ____.

Use mocks or synthetic accounts/data for rehearsal. Live enablement needs Rhys's separate approval. Retain failures and uncertain outcomes. Review after a release, provider/permission change or incident.

Source pointers: `lib/accounting/connections.ts`, `lib/integrations/xero/`, `lib/integrations/microsoft/`, `lib/email/send-company-email.ts`, `lib/email/providers/resend.ts`, `lib/ai-helper/flag.ts`, `scripts/sliq-import/`. Source review alone does not establish deployment state. Reuse #375's integration security review; this register supplies the missing owner/data/launch/fallback record.
