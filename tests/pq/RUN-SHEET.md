# Practice checks in Chrome — fake data only

Start with README.md. Use http://localhost:3007. If a page shows real people, real customers, a different address or asks for real provider credentials: **stop**. Do not type a real key. Do not send an email. A screenshot shows what was visible, not a signed result.

Tester: __________ Date: __________ Device/Chrome version: __________ Branch/SHA: __________

For each picture use Chrome's menu → More tools → Developer tools, then Ctrl+Shift+P (Mac: Cmd+Shift+P), type **Capture full size screenshot**, press Enter. Close Developer tools afterwards. Save with the name below. Never photograph a password or MFA code.

| Step | Click and look | Picture | Result |
| --- | --- | --- | --- |
| 1 | Open the local address. Enter the fake admin email/password from accounts.json. Click **Sign in**. Enter the code from `node tests/pq/pq.mjs code` when asked. If offered roles, choose **Continue as Admin**. You should reach the dashboard for **FAKE JNR Engineering PQ**. | 01-dashboard.png | ☐ Pass ☐ Fail |
| 2 | Click **Customers**. Find **FAKE Pump Customer Ltd** and **FAKE Shaft Customer Ltd**. Open the pump customer. Its address/email must be clearly fake. | 02-customers.png | ☐ Pass ☐ Fail |
| 3 | Click **Settings**. Find **Costing rates**. You should find **FAKE 6082 aluminium** at £4.50/kg and **FAKE CNC Mill** at £45.00/hour, with company labour £20.00/hour and overhead 150%. Do not change them. The fake bracket code is also shown on the seeded quote/delivery lines; this app has no separate Parts page. | 03-rates.png | ☐ Pass ☐ Fail |
| 4 | Click **Quote Generator**. Find **QUO-PQ-0001** in Drafts. Open **Edit** to look at the bracket line: quantity 10 and unit price £12.50. Close without saving. Do not click Send. | 04-quote.png | ☐ Pass ☐ Fail |
| 5 | Click **Sales Orders**. Find **SO-PQ-0001** with customer PO **FAKE-CUSTOMER-PO-0001**. Open its details. It should refer to QUO-PQ-0001 and J-PQ-0001. | 05-customer-po.png | ☐ Pass ☐ Fail |
| 6 | Click **Job Board**. Find its row and click **Worksheet** for **J-PQ-0001**. It should describe ten fake brackets and be in machining, with a future due date. Find its profitability/cost view: one hour labour is £20.00, overhead £10.00, total actual cost £30.00. Profit remains unavailable because the invoice is still a draft. Do not finish or inspect it just to make a figure appear. | 06-job-cost.png | ☐ Pass ☐ Fail |
| 7 | Find **J-PQ-NO-COST** and click its **Worksheet** button. Its cost view must show **Incomplete** with reasons and **Not available** cost figures, rather than pretending it has a complete £0 cost. | 07-missing-cost.png | ☐ Pass ☐ Fail |
| 8 | Click **Delivery Notes**. Find **DLN-PQ-0001**. It is pending, for ten FAKE-PART-BRACKET items, linked to the job/order. Open its preview/print view; cancel Chrome's print dialog. There must be no customer signature. Do not mark it dispatched. | 08-delivery.png | ☐ Pass ☐ Fail |
| 9 | Click **Invoicing**. Find draft **INV-PQ-0001**. Open its preview. Check £125.00 before VAT, £25.00 VAT and £150.00 total, with the fake customer PO. Close it. Do not send or approve it. | 09-invoice.png | ☐ Pass ☐ Fail |
| 10 | Click **Approval Queue**. Find **SYNTHETIC PQ: invoice approval draft**. Read the fake address/body. Leave it as a draft; do not click Send or Mark as Sent Manually. | 10-approval.png | ☐ Pass ☐ Fail |
| 11 | Open **Integrations** from the admin menu. Xero must not be connected or transferring. Open **AI Helper** if visible: AI must remain off/unavailable without credentials. Do not configure either. | 11-provider-status.png | ☐ Pass ☐ Fail |
| 12 | Sign out. Sign in using the fake workshop account from accounts.json. Choose **Continue as Workshop** if offered. Open Jobs on the workshop screen/tablet (or Chrome device toolbar at 1024×768). Find J-PQ-0001. It must not expose admin rates/invoice money or provider controls. | 12-workshop.png | ☐ Pass ☐ Fail |

Stop on a missing record, error, wrong company, unexplained money difference or a provider becoming active. Keep the screenshot and exact message; mark Fail. Do not edit the database to make a check pass. Reset before repeating checks that changed data. This starter sheet covers this synthetic fixture only; it does not replace the full agreed PQ pack or real-data rehearsal.

Notes/failures: __________________________________________________________

Tester signature: ____________________ Reviewer signature: ____________________
