import type { UserRole } from "@/types";

/**
 * Sidebar sections an admin can hide from one person (Admin > Users > Page access), on top of their role.
 * Keys match organization_members.hidden_sections and public.member_section_keys() (migration 012).
 * `data: true`: the database also refuses the rows (restrictive RLS); otherwise only the page is blocked, because
 * other pages share that data (a quote needs its customer, a delivery note its job).
 */
export type MemberSection = { key: string; href: string; label: string; roles: UserRole[]; data: boolean };

export const MEMBER_SECTIONS: MemberSection[] = [
  { key: "email", href: "/email", label: "Email & Payment Automation", roles: ["admin", "office"], data: true },
  { key: "rfq", href: "/rfq", label: "RFQ Control Centre", roles: ["admin", "office"], data: true },
  { key: "quotes", href: "/quotes", label: "Quote Generator", roles: ["admin", "office"], data: true },
  { key: "sales-orders", href: "/sales-orders", label: "Sales Orders", roles: ["admin", "office"], data: true },
  { key: "jobs", href: "/jobs", label: "Job Board", roles: ["admin", "office", "workshop", "viewer"], data: false },
  { key: "schedule", href: "/schedule", label: "Machine Schedule", roles: ["admin", "office", "workshop", "viewer"], data: false },
  { key: "invoices", href: "/invoices", label: "Invoicing", roles: ["admin", "office"], data: true },
  { key: "approval", href: "/approval", label: "Approval Queue", roles: ["admin", "office"], data: true },
  { key: "purchase-orders", href: "/purchase-orders", label: "Purchase Orders", roles: ["admin", "office"], data: true },
  { key: "delivery-notes", href: "/delivery-notes", label: "Delivery Notes", roles: ["admin", "office", "workshop"], data: false },
  { key: "customers", href: "/customers", label: "Customers", roles: ["admin", "office"], data: false },
  { key: "suppliers", href: "/suppliers", label: "Suppliers", roles: ["admin", "office"], data: false },
];

export const MEMBER_SECTION_KEYS = MEMBER_SECTIONS.map((section) => section.key);

/** The section a path belongs to ("/quotes/new" -> "quotes"), or null for pages that can't be hidden. */
export function sectionForPath(path: string): string | null {
  const match = MEMBER_SECTIONS.find((section) => path === section.href || path.startsWith(`${section.href}/`));
  return match?.key ?? null;
}

/** Sections a person's roles give them at all (the ones worth showing a tick box for). */
export function sectionsForRoles(roles: (UserRole | string | null | undefined)[]) {
  const held = roles.filter(Boolean) as string[];
  return MEMBER_SECTIONS.filter((section) => section.roles.some((role) => held.includes(role)));
}
