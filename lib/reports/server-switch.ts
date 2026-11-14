/**
 * BOUNDARY: server side of the Reports and Revenue switches, used only by the two reports layouts. Inputs: the signed-in session (cookie client,
 * RLS applies) and the company's hidden_nav marker. Output: true only when the switch is ON and the person holds admin or office; every other
 * case (no session, no row, any error, workshop, viewer, other module's marker) is false, so the layout stops before any report data is read.
 * The role comes from the app's existing requireProfile(admin, office) helper (lib/server/auth.ts); no rpc here. Reads ONLY organization_settings.hidden_nav. Must not change: fail-closed behaviour, the admin/office list, or add
 * any report table read here. Visibility switch, not a security boundary: RLS stays the data protection.
 */
import { isErrorResponse, requireProfile } from "@/lib/server/auth";
import { REPORTS_ON_MARKER, reportsEnabled } from "@/lib/reports/reports-switch";
import { REVENUE_ON_MARKER, revenueEnabled } from "@/lib/reports/revenue/revenue-switch";

export type SwitchRead = { ok: boolean; hiddenNav: readonly string[] | null; roleAllowed: boolean };
export type SwitchReader = () => Promise<SwitchRead>;

const FAILED: SwitchRead = { ok: false, hiddenNav: null, roleAllowed: false };

/** Pure: ON only when the read worked, the role is admin/office, and the module's own marker is present. */
export function decideSwitch(enabled: (hiddenNav?: readonly string[] | null) => boolean, read: SwitchRead): boolean {
  return read.ok && read.roleAllowed && enabled(read.hiddenNav);
}

/** The real reader. Any problem (no env, no session, error, no row) fails closed. */
export const readCompanySwitch: SwitchReader = async () => {
  try {
    const ctx = await requireProfile(["admin", "office"]);
    if (isErrorResponse(ctx)) return FAILED;
    const { data, error } = await ctx.supabase.from("organization_settings").select("hidden_nav").maybeSingle();
    if (error || !data) return FAILED;
    return { ok: true, roleAllowed: true, hiddenNav: Array.isArray(data.hidden_nav) ? (data.hidden_nav as string[]) : [] };
  } catch {
    return FAILED;
  }
};

export async function reportsEnabledForCompany(read: SwitchReader = readCompanySwitch): Promise<boolean> {
  return decideSwitch(reportsEnabled, await read());
}

export async function revenueEnabledForCompany(read: SwitchReader = readCompanySwitch): Promise<boolean> {
  return decideSwitch(revenueEnabled, await read());
}

export { REPORTS_ON_MARKER, REVENUE_ON_MARKER };
