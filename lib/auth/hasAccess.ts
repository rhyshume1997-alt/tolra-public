export type Role = "admin" | "office" | "workshop" | "viewer";

const PAGE_ACCESS: Record<string, Role[]> = {
  dashboard: ["admin", "office", "workshop", "viewer"],
  customers: ["admin", "office"],
  suppliers: ["admin", "office"],
  rfqs: ["admin", "office"],
  rfq: ["admin", "office"],
  quotes: ["admin", "office"],
  jobs: ["admin", "office", "workshop", "viewer"],
  schedule: ["admin", "office", "workshop", "viewer"],
  "sales-orders": ["admin", "office"],
  "purchase-orders": ["admin", "office"],
  "delivery-notes": ["admin", "office", "workshop"],
  invoicing: ["admin", "office"],
  invoices: ["admin", "office"],
  machines: ["admin", "office", "workshop"],
  email: ["admin", "office"],
  approval: ["admin", "office"],
  admin: ["admin"],
  settings: ["admin"],
};

export function hasAccess(page: string, role: Role, secondaryRole?: Role | null): boolean {
  const allowed = PAGE_ACCESS[page] || [];
  return allowed.includes(role) || Boolean(secondaryRole && allowed.includes(secondaryRole));
}

export { PAGE_ACCESS };
