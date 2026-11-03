export const DEMO_SLUG: string;
export const DEMO_NAME: string;
export const DEMO_ADMIN_EMAIL: string;
export const THROWAWAY_FLAG: string;
export function assertThrowaway(input?: { argv?: string[]; env?: Record<string, string | undefined> }): void;
export type DemoPlan = {
  customers: { name: string; email: string }[];
  invoices: { invoice_ref: string; customer: string; invoice_date: string; due_date: string; status: string; lines: { description: string; quantity: number; unit_price: number }[]; state: "paid" | "due" | "overdue" }[];
  payments: { invoice_ref: string; paid_on: string; amount: number; method: string }[];
  jobs: { job_no: string; customer: string }[];
  machines: { name: string }[];
  times: { job: string; machine: string; labourStartHoursAgo: number; labourStopHoursAgo: number; runStartHoursAgo: number; runStopHoursAgo: number }[];
  profile: Record<string, unknown>;
};
export function planDemoData(today?: Date): DemoPlan;
export function importPayload(plan: DemoPlan, runLabel?: string): Record<string, unknown>;
