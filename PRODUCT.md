# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

An installable web app (PWA) with offline support, used on desktop browsers in the office and on tablets in the workshop.

## Users

- **Primary: office staff and owners of small UK engineering and CNC workshops.** They work at a desk and run the commercial side of the shop all day: answering RFQs, building quotes, raising sales and purchase orders, approving work, despatching and invoicing. The product is designed around them first.
- **Secondary: workshop operators on the shop floor.** They use tablets, often while wearing gloves, to work the job board, start and finish work, log time, take job photos and sign off jobs.
- **Also present:** admins who manage users, company settings, integrations and compliance, and read-only viewers.

## Product Purpose

Tolra runs a small engineering workshop's whole commercial and production flow, from the first enquiry to the paid invoice: RFQ → quote → sales order → job → machine schedule → delivery note → invoice. It exists so a small shop can stop re-keying the same job across spreadsheets, accounting software and paper worksheets. Success means every job flows through one chain with nothing typed twice and nothing done but left unbilled.

## Positioning

- **One flow, RFQ to invoice.** Quote, job, schedule, delivery and invoice are one linked chain. Each step comes from the one before it, so nothing is re-keyed.
- **Built for small UK shops.** UK VAT, Xero and ISO 9001 traceability are built in, without the weight or cost of a big ERP such as JobBOSS or ProShop.
- **Works on the floor.** Usable on tablets, works offline, and captures time, photos and sign-off where the work happens.
- **Catches money leaks.** Guards against double billing and uninvoiced deliveries, plus an AI finance check before invoices go out.

## Operating Context

- Two settings: the office (desk, mouse, keyboard, dense tables) and the shop floor (tablet, coarse pointer, gloves, an unreliable network).
- Roles: admin, office, workshop, viewer. Navigation and dashboard tiles are filtered by role.
- Multi-company. One user can belong to several companies and choose between them. A platform owner can see every company.
- Physical documents are part of the job: printed job worksheets, delivery notes, sales orders, purchase orders and timesheets, plus customer sign-off and certificate packs.
- Connected tools: Xero for accounting, email via Resend, and an optional CNC costing engine that prices quote lines.

## Capabilities and Constraints

- Modules: Dashboard, RFQ Control Centre, Quote Generator, Sales Orders, Job Board, Machine Schedule, Weekly hours, Invoicing, Approval Queue, Purchase Orders, Delivery Notes, Customers, Suppliers, Email, Settings, and admin pages (users, activity, data import, integrations, compliance).
- Traceability for ISO 9001: authorised inspectors, inspection records, drawing revisions, cert packs and an audit trail.
- Offline-first workshop use: local store, an outbox and sync, with a visible connection state.
- Stack: Next.js (a version with breaking changes; read `node_modules/next/dist/docs/` before writing code), React 19, Tailwind 4, shadcn/Radix, Supabase. Deployed on Vercel. The content security policy allows self-hosted fonts only.
- Layout breakpoint: the fixed sidebar and dense tables start above 1024px. At 1024px and below, navigation is a drawer and records show as cards or compact lists.
- Demo mode (sample records) is for local demos only and must never be on in production.
- Terminology: RFQ, quote, sales order, job, worksheet, delivery note, despatch, purchase order, credit note, sign-off, cert pack, machine.

## Brand Commitments

- Product name: **Tolra**. Tagline: "Quotes, jobs and invoices for engineering workshops." Both are defined once, in `lib/product.ts`.
- **The company comes first; Tolra is the credit.** Each company sets its own name, logo and colours, which lead on its own screens and on its branded sign-in page. Tolra appears as a small credit ("JNR Engineering Ltd · Tolra"). The Tolra app icon and neutral colours are used only when a company hasn't set its own.
- Language: British English (organisation, colour, despatch).

## Evidence on Hand

- One live customer: JNR Engineering, which uses Tolra in production.
- No testimonials, case studies, customer logos, metrics, pricing or press exist yet. Future work must not invent them.
- No Tolra logo file is in the repo. The app icon is generated in code (`lib/server/app-icon.tsx`, monogram "T").

## Product Principles

1. **One record, carried forward.** Every step comes from the step before it. Design never asks someone to type again what the system already knows.
2. **The office is home; the floor must never stall.** Optimise for desk throughput and density first, but workshop screens stay glove-usable and offline-safe.
3. **Money is never silently wrong.** Billing, VAT and quantities get guards, confirmations and visible state. Getting them right beats saving a click.
4. **Small-shop weight.** Every feature should feel lighter than an ERP: plain language, sensible defaults, nothing a five-person shop has to configure before it can work.
5. **The customer's company, not ours.** Each company's identity leads, and Tolra stays in the background.

## Accessibility & Inclusion

- Workshop touch targets are sized for gloved hands. Start and Finish buttons are at least 64px high on coarse pointers (`app/(dashboard)/jobs/page.tsx`).
- Screens must stay readable when company brand colours are applied over them, so contrast cannot assume the default palette.
