# Create, check and approve documents — 7.5

Document ID: JNR-I2-DOCUMENT-REVISION-APPROVAL-PROCEDURE | Version: 0.1 draft | Prepared: 4 November 2026

Proposed owner: John (JNR), with Rhys for Tolra technical facts. Owner appointment, approval, effective date and next review: ____ .

Tolra supports JNR Engineering’s quality work. Software and documents cannot make a company certified. JNR is the company that gets audited. This draft is not evidence that JNR follows the process or meets ISO 9001:2015.

## Use after John approves it

1. **Name it.** Give each policy, procedure, form, drawing or outside instruction a unique ID, title, owner and storage location. Put it in the controlled-documents register. A blank form is controlled; a completed form becomes a record.
2. **Write it.** The owner writes short steps and checks them with the people who use them. Show version, draft status, change reason and affected jobs. Mark example text clearly. Check customer, legal and licensed-standard needs.
3. **Check it.** A named competent person checks accuracy, links, usability and changes. For software facts, Rhys checks the exact code/release. Record reviewer, date, comments and evidence. Do not approve your own unreviewed technical claim.
4. **Approve it.** John or his named authorised delegate approves JNR use. Record approver, date and effective date in the register and document. A Git commit, green check or draft PR is not this approval. Keep all approval fields blank until it happens.
5. **Issue it.** Put the approved master in the agreed read-only location. Tell affected people what changed and record any needed training. Keep a distribution list for shop copies. Confirm each workstation has the right revision before work starts.
6. **Replace it.** Move the old master to the restricted archive, mark it Obsolete, remove old shop copies and retain change/approval history. Never overwrite a completed quality record to hide a mistake. Link its dated correction and reason.
7. **Review it.** Review at the agreed date and after a process, customer, legal or software change, incident or audit finding. A review with no change still needs reviewer/date/result. A real change gets a new version and steps 2–6.

**Version rule proposed for approval:** 0.x = draft. First approved issue = 1.0. Each approved change increases the version. Preserve the exact Git commit/blob as the software document’s source version. A source hash is not a JNR approval version.

**Outside documents:** register customer drawing/specification numbers and revisions, standards and supplier instructions; record who checks updates and where the authorised copy is held. Check the contract’s required revision rather than simply choosing the newest one. Resolve conflicts before making parts. Do not copy licensed standards into this public repo.

**Prints:** mark untracked printouts “Uncontrolled when printed — check the master before use”. If paper is needed to make parts, issue a numbered controlled copy, record holder/revision/date and replace it when changed. Include controlled fallback packs for outages.

**Access and retention:** John names readers/editors/approvers and a deputy; Rhys manages technical permissions. Keep private customer records outside public GitHub. Use the records procedure for storage, backup, restore, retention, legal holds and disposal. Verify that staff can find and read the right document.

## Approval/change record — complete for each issue

Document ID ____; old/new version ____; change and reason ____; affected jobs/copies ____; source commit ____; writer/date ____; checker/date/evidence ____; approver/date ____; effective date ____; staff told/trained ____; next review ____; old copies removed by/date ____.

This is a proposed manual control. Tolra does not supply a general document-approval workflow. John must appoint actual owners and decide the review period. See `CONTROLLED-DOCUMENTS-REGISTER.md` and `CONTROL-OF-RECORDS.md` (I4, separate draft).
