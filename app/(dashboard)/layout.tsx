import { AiFeaturesProvider } from "@/components/ai-features";
import { DashboardShell } from "@/components/dashboard-shell";
import { UiV2Skin } from "@/components/ui/ui-v2-skin";
import { aiFinanceCheckEnabled } from "@/lib/ai/finance-check/flag";
import { aiHelperEnabled } from "@/lib/ai-helper/flag";
import { toolyTourEnvEnabled } from "@/components/tooly/tour/tour-switch";
import { type ShellBrand, shellBrandFrom } from "@/lib/brand-pending";
import { createSupabaseServerClient } from "@/lib/server/auth";

const COMPANY_READ_TIMEOUT_MS = 1000;

/**
 * The signed-in company's brand (name, colours, logo URL), read on the server AS THE SIGNED-IN USER (their own session cookie, never
 * the service role), so RLS answers with this session's company only: the same read the browser makes (lib/company.ts
 * loadCompanyProfile). It lets the shell paint the company's name, colours and logo first time. Only those fields leave this
 * function: the rest of the profile (address, VAT number, bank details...) is never put into the page HTML, and the browser reads
 * it itself as before. Any error, no row, no session or a slow answer is undefined (offline pages keep working).
 */
async function readCompany(): Promise<ShellBrand | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const supabase = await createSupabaseServerClient();
    if (!supabase) return undefined;
    const read = supabase.from("organization_settings").select("organization_id, company_profile").maybeSingle()
      // No row is left to the browser too (it may be a session the server could not see): only a row it found is handed over.
      .then(({ data, error }): ShellBrand | undefined => (error || !data || typeof data.organization_id !== "string" ? undefined : shellBrandFrom(data.organization_id, data.company_profile) ?? undefined));
    return await Promise.race([read, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), COMPANY_READ_TIMEOUT_MS); })]);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // toolyTour: whether the Tooly tour may show, as a plain boolean. ON by default; off only when TOOLY_TOUR_DISABLED is exactly "true"
    // (components/tooly/tour/tour-switch.ts). The role (admin, office, workshop) still decides which tour, and a viewer gets none.
    // AI features this server has on: plain booleans only (the env var stays on the server). All off by default. Outside the shell, so
    // the sidebar (inside it) can show the AI item too.
    <AiFeaturesProvider value={{ financeCheck: aiFinanceCheckEnabled(), aiHelper: aiHelperEnabled() }}>
      <DashboardShell company={await readCompany()} toolyTour={toolyTourEnvEnabled()}><UiV2Skin />{children}</DashboardShell>
    </AiFeaturesProvider>
  );
}
