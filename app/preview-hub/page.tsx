// DO NOT MERGE: preview hub. Inputs: none. Output: the index of every premium UI preview screen, grouped by module, each with a one-line description.
// Static server page, no data, no network. Must not be merged into any product branch; links point at the preview routes (see next.config.mjs rewrites).
import type { Metadata } from "next";
import { Callout, Panel, PageHeader, PreviewBar } from "@/components/ui/premium";
import { premiumTokens, cx } from "@/components/ui/premium/tokens";

export const metadata: Metadata = { title: "Tolra UI preview: all screens", robots: { index: false, follow: false, nocache: true } };

type Screen = { href: string; name: string; text: string };
type Group = { title: string; screens: Screen[] };

const GROUPS: Group[] = [
  { title: "Overview", screens: [
    { href: "/dashboard", name: "Dashboard", text: "The signed-in home: today's work, what needs attention and quick links." },
    { href: "/numbers", name: "Numbers", text: "Money at a glance: invoiced, owed, credit notes and cash trend." },
    { href: "/reports", name: "Reports", text: "Operations and revenue reports with date ranges and breakdowns." },
    { href: "/ai-helper", name: "AI section", text: "The optional AI helper settings and what it may do (off by default)." },
  ] },
  { title: "Sales: RFQ, quotes, sales orders", screens: [
    { href: "/rfq", name: "RFQ Control Centre", text: "Incoming requests for quote, who owns each and what is waiting." },
    { href: "/quotes", name: "Quote Generator", text: "The quote list with status, value and the new-quote flow." },
    { href: "/sales-orders", name: "Sales Orders", text: "Confirmed orders from customers and their progress to delivery." },
  ] },
  { title: "Jobs, schedule and time", screens: [
    { href: "/jobs", name: "Job Board", text: "Every job by stage, with filters, columns and the job card." },
    { href: "/jobs/ncr", name: "NCR register", text: "Non-conformance reports: raised, open and closed, with causes." },
    { href: "/schedule", name: "Machine Schedule", text: "Machines against days, with the work booked on each." },
    { href: "/time", name: "Weekly hours", text: "Each person's hours for the week, ready to approve." },
  ] },
  { title: "Invoicing and purchasing", screens: [
    { href: "/invoices", name: "Invoicing", text: "Invoices by status with what is due, overdue and paid." },
    { href: "/approval", name: "Approval Queue", text: "Items waiting for a decision before they go out." },
    { href: "/purchase-orders", name: "Purchase Orders", text: "Orders placed with suppliers and what has arrived." },
    { href: "/delivery-notes", name: "Delivery Notes", text: "What left the workshop, for which job and customer." },
    { href: "/email", name: "Email history", text: "Every email the system sent, to whom, and whether it arrived." },
  ] },
  { title: "Customers and suppliers", screens: [
    { href: "/customers", name: "Customers", text: "Customer list with contacts, balances and recent work." },
    { href: "/suppliers", name: "Suppliers", text: "Supplier list with contacts, terms and recent orders." },
    { href: "/portal", name: "Customer portal", text: "What a customer sees: their quotes, jobs and documents (no staff menu)." },
  ] },
  { title: "Admin and settings", screens: [
    { href: "/admin/users", name: "User Management", text: "People, roles and invitations. Has a role switcher to try." },
    { href: "/admin/activity", name: "Activity", text: "Who did what and when, with filters." },
    { href: "/admin/compliance", name: "Security", text: "Sign-in rules, two-step checks and audit." },
    { href: "/admin/data", name: "Data", text: "Import, export and undo of company data (shown, never run)." },
    { href: "/admin/integrations", name: "Integrations", text: "Xero and other connections, and what each can do." },
    { href: "/admin/integrations/xero-organisation", name: "Confirm the Xero organisation", text: "The step that checks the right Xero company is linked." },
    { href: "/admin/iso", name: "ISO templates", text: "Quality document templates and their versions." },
    { href: "/settings", name: "Settings", text: "Company profile, defaults, numbering and what is switched on." },
  ] },
  { title: "Shared set", screens: [
    { href: "/dashboard/ui-preview", name: "UI showcase", text: "Every shared component in one place: buttons, fields, tables, dialogs, toasts." },
  ] },
];

const wrap = { maxWidth: 960, margin: "0 auto", padding: "16px 16px 64px", display: "grid", gap: 20 } as const;

export default function PreviewHubPage() {
  return (
    <main className={cx(premiumTokens)} style={{ minHeight: "100vh", background: "#f6f7f9" }}>
      <PreviewBar label="Preview, sample data, nothing is saved" />
      <div style={wrap}>
        <PageHeader title="Tolra UI preview" description="Every premium preview screen in one clickable site. Fake data, a fake signed-in admin, no server behind it." />
        <Callout tone="info" lead="Note">
          Each screen opens inside the real sidebar and top bar (portal excepted). Use the "Sidebar role" box at the top of a screen to see the menu as Admin, Office, Workshop or Viewer;
          screens with their own "Preview controls" let you try other states and roles. Dialogs, menus and forms all work, but nothing is saved and nothing leaves your device. Use "All previews" on any screen to come back here.
        </Callout>
        {GROUPS.map((g) => (
          <Panel key={g.title} title={g.title} headingLevel={2} bare>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {g.screens.map((s, i) => (
                <li key={s.href} style={{ borderTop: i ? "1px solid rgba(14,23,38,0.08)" : undefined }}>
                  <a href={s.href} style={{ display: "grid", gap: 2, padding: "12px 16px", minHeight: 48, color: "inherit", textDecoration: "none" }}>
                    <span style={{ fontWeight: 600, fontSize: 15, lineHeight: "22px" }}>{s.name} <span style={{ fontWeight: 400, color: "#566074", fontSize: 12 }}>{s.href}</span></span>
                    <span style={{ color: "#566074", fontSize: 14, lineHeight: "20px" }}>{s.text}</span>
                  </a>
                </li>
              ))}
            </ul>
          </Panel>
        ))}
      </div>
    </main>
  );
}
