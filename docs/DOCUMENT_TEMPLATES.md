<!--
BOUNDARY: documentation for module J (document templates). Inputs: the code on main at the time of writing. Outputs: how documents are made
today (Step 1) and how the template system works (Step 2). Changes no code, flag or setting. Keep in step with docs/MODULES.md.
-->

# Document templates (module J)

## Step 1: how documents are generated and printed today

- **One PDF engine.** Quotes, invoices, purchase orders and delivery notes (and sales orders and credit notes) are built with `@react-pdf/renderer`, in the browser, loaded on first use (`lib/download-pdf.tsx`: `downloadPdf`, `pdfBlob`). The same element is downloaded, attached to a one-click e-mail, or put in the year-end export zip (`lib/year-end-export.tsx`).
- **One layout for all.** `components/pdf/BaseDocumentPDF.tsx` is the single A4 layout (Helvetica, black rules, JNR's paperwork): company name and key/value box top left, title and logo top right, two address blocks, ruled line-item table, message box, totals, company footer. Each document is a thin wrapper that prepares data and calls it: `QuotePDF.tsx`, `InvoicePDF.tsx`, `PurchaseOrderPDF.tsx`, `DeliveryNotePDF.tsx` (delivery notes use a quantity-only table plus the goods-out and Received by lines, `lib/delivery-note-print.ts`).
- **Numbers.** Totals, VAT per line and per rate, carriage, payments and balance come from `lib/money.ts` through `components/pdf/pdf-totals.ts`. A quote or invoice whose lines do not add up to its stored totals is refused (`lib/document-integrity`). Invoice payment wording comes from `lib/invoice-pdf-data.ts`; document numbers are passed in (QUO-, INV-, PO-, DLN-).
- **Logo.** The company's uploaded logo (`company_profile.logoPath`, private `org-logos` bucket) is loaded as a data URL (`lib/company.ts`); with no logo the company name is printed.
- **Brand colour.** `company_profile.brandPrimary` / `brandAccent` exist and colour the app shell and login. **Today's PDFs do not use them** (black and white).
- **Terms.** `defaultQuoteTerms`, `defaultInvoiceTerms`, `defaultCustomerMessage`, `defaultInvoiceMessage` in the company profile.
- **Bank details.** `company_profile.bankDetails` (`lib/bank-details.ts`), printed on invoices only.
- **Issued documents.** Quotes and invoices carry an issuer snapshot taken when they are created (migration 019, includes `capturedAt`); reprints use it for company details. Branding still comes from today's profile.
- **Job worksheet Print layout (Basic / JNR sheet).** A separate HTML print path (`lib/print-layout.ts`, `components/job-worksheet-*-print.tsx`), stored as `company_profile.printLayout`. **Out of module J**: a separate session is building the worksheet builder. J does not touch it.

## Step 2: the template system

- **Settings > Document designs** (`components/document-templates/document-designs-card.tsx`, also what step 2 "Logo and colours" of the company setup points to): per document type pick one design, live preview on invented sample data, save. A switch "Use these designs on my documents" is **off by default**.
- **Stored** in `company_profile.documentTemplates` (no migration): `{ enabled, quote|invoice|purchase_order|delivery_note: [{ design, from }] }`, an append-only history (`lib/document-templates/document-template-settings.ts`). Other modules (the owner rollout) use `setDesignChoice`, `withTemplatesEnabled`, `resolveDesignId`.
- **Designs**: `classic` (= `BaseDocumentPDF`, unchanged, the default and the fallback), `modern`, `minimal`. **Adding a design = one file in `components/pdf/templates/` + one entry in `components/pdf/templates/registry.ts`.**
- **Same numbers in every design.** New designs print only what `components/pdf/templates/document-model.ts` gives them, built by the same functions as classic.
- **Issued documents never change.** A document prints with the design in force on the day it was created/issued (issuer snapshot `capturedAt` for quotes and invoices; the document date for purchase orders and delivery notes; the issue date given by the year-end export). An issued quote or invoice with no recorded date (imported, or before snapshots) stays classic. Drafts use the design in force now.
- **Logo and brand colour** come from the company profile (the logo uploaded in Company details, `brandPrimary`), with a neutral navy and the company name when there is no logo. Classic is exactly today's output and so does not use the brand colour; modern and minimal do.
- **No SQL.** Release 169 was not needed. If a per-document design column is wanted later (to freeze the design on the record itself rather than by date), that is release 169, with its own release, rollback, verify and preflight files like release 163.
- **Tests**: `tests/unit/document-template-golden.test.ts` (default output equals the text recorded from the original code before this module, `tests/fixtures/document-templates`), `document-template-settings.test.ts`, `document-template-designs.test.ts`.
