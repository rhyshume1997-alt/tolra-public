export type DashboardModule =
  | "dashboard"
  | "email"
  | "rfq"
  | "quotes"
  | "jobs"
  | "invoices"
  | "approval"
  | "sales-orders"
  | "purchase-orders"
  | "delivery-notes"
  | "stock"
  | "machines";

export type ModuleStatus = "new" | "active" | "pending" | "complete" | "overdue";

export interface BaseRecord {
  id: string;
  company_id: string;
  created_at: string;
  updated_at: string;
}

export interface Customer extends BaseRecord {
  name: string;
  email?: string;
  phone?: string;
}

export interface Rfq extends BaseRecord {
  customer_id: string;
  reference: string;
  description: string;
  estimated_value?: number;
  status: "new" | "clarification" | "ready" | "quoted";
}

export interface Quote extends BaseRecord {
  rfq_id: string;
  reference: string;
  value: number;
  status: "draft" | "sent" | "accepted" | "rejected";
}

export interface Invoice extends BaseRecord {
  customer_id: string;
  customer?: string;
  reference: string;
  total: number;
  amount?: number;
  due_date: string;
  status: "draft" | "sent" | "partial" | "paid" | "overdue" | "outstanding";
  days_overdue?: number;
  payment_pattern?: string;
}

export interface JobRecord {
  id: string;
  job_no: string;
  customer: string;
  description: string;
  stage: string;
  due_date: string;
  /** Demo data only. Real job prices live in job_values (admin/office only) and are never loaded with the job. */
  value?: number;
  /** "rework" while a failed inspection is being reworked (migration 037). */
  status: "on_track" | "at_risk" | "overdue" | "rework";
  /** Made for the company itself (migration 042): the customer is optional. */
  is_internal?: boolean;
  /** The one related job (rework or tooling for job X), migration 042. */
  related_job_id?: string;
}

export interface MachineRecord {
  id: string;
  name: string;
  type: string;
  last_service: string;
  next_service: string;
  days: string;
  hours_this_month: number;
  status: "overdue" | "due_soon" | "healthy" | "in_service";
}

export type UserRole = "admin" | "office" | "workshop" | "viewer";

export interface UserProfile {
  id: string;
  email: string;
  full_name: string | null;
  role: UserRole;
  secondary_role: UserRole | null;
  organization_id?: string | null;
  organization: string | null;
  workshop_email: string | null;
  active?: boolean;
  mfa_required?: boolean;
  last_login_at?: string | null;
  created_at?: string;
}

export interface SalesOrder {
  id: number;
  order_ref: string;
  customer: string;
  order_date: string;
  expected_delivery: string;
  total_value: number;
  status: "open" | "confirmed" | "in_production" | "despatched" | "closed";
  notes?: string;
}

export interface PurchaseOrder {
  id: number;
  po_ref: string;
  supplier: string;
  order_date: string;
  expected_delivery: string;
  total_value: number;
  status: "draft" | "sent" | "confirmed" | "partial_received" | "received" | "cancelled" | "awaiting";
  notes?: string;
}

export interface DeliveryNote {
  id: number;
  dn_ref: string;
  customer: string;
  job_ref: string;
  delivery_date: string;
  status: "despatched" | "delivered" | "signed" | "awaiting";
  notes?: string;
}
