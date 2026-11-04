# AU: confusing screen wording in #232–#261

Reviewed 4 November 2026. Fixes are on #247's assembled candidate (`41c685c416305637d86b580324fff9e6cda037ff`), in one separate draft into that branch. Only displayed text changes; permissions, calculations, send/retry behaviour and stored messages are unchanged. Review covers app/components/lib differences from each PR's merge base, including server messages shown by screens. Repeated inherited wording is listed once. The fixed wording must be carried into the final integrated candidate; original owner branches are untouched.

| Source PRs / screen | Confusing words | Replacement / reason |
| --- | --- | --- |
| #234/#237/#247 accounting connection and its API error | “app registration and database update” | “This connection is not ready yet. Ask Tolra support to finish setting it up.” Gives the user an action without requiring technical knowledge. |
| #234/#237/#247 accounting payment result | “Balance evidence only” | “This balance does not prove a payment was received. A credit can reduce it too. Check the payment records before marking the invoice paid.” Explains the limit of the result. |
| #234/#247 AI connection | “not switched on for this server” | “AI is unavailable. Ask your admin to contact Tolra support.” A shop user does not manage a server. |
| #233/#247 chase settings and run error | “database update 138” | “Payment reminder settings are not available yet. Ask your admin to contact Tolra support.” The update number does not help staff act. |
| #232/#234/#247 owner AI limits | “used plus reserved”; “Reserved” | Explain the total as already used plus money held for requests waiting for an answer. Keep pence, £10/£1,000 limits and arithmetic unchanged. |
| #236/#247 email editor | “typing markers” | “typing special codes.” Makes the Add detail instruction understandable. |

This is the wording issue list only. No copy preference changes or new feature promises are included. Snapshot coverage and test outcomes are in the job handover. No database, provider or visual browser rehearsal was performed for this text edit.
