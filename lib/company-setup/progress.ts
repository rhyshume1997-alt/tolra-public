import type { SupabaseClient } from "@supabase/supabase-js";

export const SETUP_STEPS = [
  { id: "company", label: "Company details", hint: "Add the name, address and VAT details for your documents.", href: "/settings#setup-company" },
  { id: "branding", label: "Logo and colours", hint: "Add your logo and choose your company colours.", href: "/settings#setup-company" },
  { id: "hours", label: "Working hours", hint: "Choose the days and hours your workshop works.", href: "/settings#setup-company" },
  { id: "breaks", label: "Paid or unpaid breaks", hint: "Check whether breaks are paid and how long they last.", href: "/settings#setup-breaks" },
  { id: "people", label: "People and roles", hint: "Add your team and choose what each person can see and change.", href: "/admin/users" },
  { id: "connections", label: "Accounting connections", hint: "Connect Xero if you use it, or leave this off.", href: "/admin/integrations" },
  { id: "ai", label: "AI help", hint: "Choose whether to use AI. It is optional and stays off until you turn it on.", href: "/admin/integrations" },
  { id: "email", label: "Email", hint: "Connect your mailbox and check the emails your company sends.", href: "/settings#setup-email" },
  { id: "import", label: "Import your records", hint: "Bring in your own records after you have checked the settings above. You can also start with no records.", href: "/admin/data" },
] as const;
export type SetupStep = typeof SETUP_STEPS[number]["id"];
export type SetupProgress = Partial<Record<SetupStep, boolean>>;
export function setupProgressFor(org: string, rows: Array<{ organization_id: string; step: string; completed: boolean }>): SetupProgress {
  const progress: SetupProgress = {};
  for (const row of rows) if (row.organization_id === org && SETUP_STEPS.some(s => s.id === row.step)) progress[row.step as SetupStep] = row.completed === true;
  return progress;
}
export async function readSetupProgress(db: SupabaseClient, org: string): Promise<SetupProgress> {
  const { data, error } = await db.from("company_setup_progress").select("organization_id, step, completed").eq("organization_id", org);
  if (error) throw new Error("Setup progress is not available yet. You can still use every setup page.");
  return setupProgressFor(org, data ?? []);
}
export async function writeSetupProgress(db: SupabaseClient, org: string, step: SetupStep, completed: boolean) {
  if (!SETUP_STEPS.some(s => s.id === step)) throw new Error("Unknown setup step.");
  const { error } = await db.from("company_setup_progress").upsert({ organization_id: org, step, completed }, { onConflict: "organization_id,step" });
  if (error) throw new Error("Could not save setup progress. Try again.");
}
