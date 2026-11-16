# Plain-English pass

Scope checked: #110–#113 and #116–#123. #117 is a suggestion adapter, #118 writes
email copy, and #119–#122 add tests rather than screen text. No pricing formula,
chase-selection rule, stored field or API name was renamed.

- Costing: Profit added %, extra material for waste, other running costs,
  making time per part, and a quote line total explicitly before VAT.
- Settings: Days before or after due date. The negative-number explanation and
  approval note remain.
- Approvals: Edit, Approve and send, Skip and Pause chasing for this customer
  already use plain words; kept them.
- Payment claim: saved message asks the user to check the bank before confirming.
- Bank upload: Bank statement file (.csv) and Confirm payment received.
- Staff guide: corrected £100 plus 20% to £120, preserving the current calculator.

Copied props components are included to make the wording reviewable. Integrate
those changes with #132/#134 and their accessible labels/test selectors. This
branch is stacked on the costing review, not the chase wiring. No live bank
payment handler has been connected; the async-confirmation finding on #116 is
still open. The claim-form reopening issue noted on #113/#132 also remains a
wiring follow-up, not a wording fix. No existing assertion has been removed;
the costing render assertions now check the same controls under their new labels.
