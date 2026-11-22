/**
 * BOUNDARY: lib/platform/owner-home/counts.ts (Owner Home, module 12). The ONE place the owner home gets its per-company numbers.
 * Inputs: the platform owner's own Supabase client (never the service role) and the rows platform_list_organizations returned.
 * Outputs: OwnerHomeData (one row per company plus simple totals). Read-only: nothing is written and no SQL is added here.
 * A number that is not known is null and the screen shows a dash; it is never shown as a made-up zero. The one exception is open
 * issues, which is 0 when the issues table is absent (release 165 not applied).
 * JOIN POINT: the Companies screen's counts function (release 164) is not merged. When it is, replace `listCountsSource` below with
 * a source that calls it; nothing else in this module or in the screen changes. Must not change: platform_list_organizations,
 * platform_create_organization, platform_enter_organization, or any file of the Companies screen.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type PlatformListRow = {
  organization_id: string;
  name: string;
  slug: string;
  status: string;
  active_members: number;
  own_membership: boolean;
  support_expires_at: string | null;
};

export type CompanyCounts = {
  users: number | null;
  jobs: number | null;
  invoices: number | null;
  openIssues: number | null;
  lastActivity: string | null;
};

export type OwnerHomeCompany = PlatformListRow & CompanyCounts;

export type OwnerHomeData = {
  companies: OwnerHomeCompany[];
  totals: { companies: number; activeCompanies: number; users: number; openIssues: number };
  /** Last activity across all companies, or null when no source records one yet. */
  latestActivity: string | null;
  /** True once any source supplies jobs, invoices or activity (the 164 counts); false while only the existing list is used. */
  fullCounts: boolean;
  /** Errors are not recorded anywhere the owner can read yet; stays false until a source says otherwise. */
  errorsRecorded: boolean;
};

/** One source of counts: given the companies, returns what it knows per organization id. Missing keys mean "not known". */
export type CountsSource = (client: SupabaseClient, rows: PlatformListRow[]) => Promise<Map<string, Partial<CompanyCounts>>>;

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0);

/** Keeps only well-formed rows from the database list; anything else is dropped rather than shown wrongly. */
export function parseListRows(data: unknown): PlatformListRow[] {
  if (!Array.isArray(data)) return [];
  const rows: PlatformListRow[] = [];
  for (const raw of data) {
    const r = raw as Record<string, unknown> | null;
    if (!r || typeof r.organization_id !== "string" || typeof r.name !== "string" || typeof r.slug !== "string" || typeof r.status !== "string") continue;
    rows.push({
      organization_id: r.organization_id,
      name: r.name,
      slug: r.slug,
      status: r.status,
      active_members: num(r.active_members),
      own_membership: r.own_membership === true,
      support_expires_at: typeof r.support_expires_at === "string" ? r.support_expires_at : null,
    });
  }
  return rows;
}

/** Today's source: only what the existing list gives (active members). Jobs, invoices and activity stay unknown until 164 joins. */
export const listCountsSource: CountsSource = async (_client, rows) => {
  const out = new Map<string, Partial<CompanyCounts>>();
  for (const row of rows) out.set(row.organization_id, { users: row.active_members });
  return out;
};

// Postgres "no such table / column" and PostgREST "not in the schema cache": the issues table is simply not there yet.
const ABSENT_CODES = new Set(["42P01", "42703", "PGRST205", "PGRST204"]);
const ISSUES_READ_LIMIT = 10000;

/**
 * Open issues per company, read defensively with the owner's own session. Table absent: 0 for every company. Any other failure
 * (for example a policy that hides the rows): null, shown as a dash. ASSUMES release 165 gives `issues` an `organization_id` and a
 * `status` that equals "open" while open; if 165 differs, change only this function.
 */
export async function readOpenIssues(client: SupabaseClient, rows: PlatformListRow[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  try {
    const { data, error } = await client.from("issues").select("organization_id").eq("status", "open").limit(ISSUES_READ_LIMIT);
    if (error) {
      const value = ABSENT_CODES.has(String(error.code)) ? 0 : null;
      for (const row of rows) out.set(row.organization_id, value);
      return out;
    }
    for (const row of rows) out.set(row.organization_id, 0);
    for (const item of (data ?? []) as Array<{ organization_id?: unknown }>) {
      const org = typeof item.organization_id === "string" ? item.organization_id : null;
      if (org && out.has(org)) out.set(org, (out.get(org) ?? 0) + 1);
    }
  } catch {
    for (const row of rows) out.set(row.organization_id, null);
  }
  return out;
}

const latest = (a: string | null, b: string | null): string | null => (a && b ? (Date.parse(a) >= Date.parse(b) ? a : b) : a ?? b);

export async function loadOwnerHome(
  client: SupabaseClient,
  rows: PlatformListRow[],
  sources: { counts?: CountsSource; issues?: typeof readOpenIssues } = {},
): Promise<OwnerHomeData> {
  const [counts, issues] = await Promise.all([
    (sources.counts ?? listCountsSource)(client, rows).catch(() => new Map<string, Partial<CompanyCounts>>()),
    (sources.issues ?? readOpenIssues)(client, rows).catch(() => new Map<string, number | null>()),
  ]);

  const companies: OwnerHomeCompany[] = rows.map((row) => {
    const c = counts.get(row.organization_id) ?? {};
    return {
      ...row,
      users: c.users ?? null,
      jobs: c.jobs ?? null,
      invoices: c.invoices ?? null,
      openIssues: issues.get(row.organization_id) ?? c.openIssues ?? null,
      lastActivity: c.lastActivity ?? null,
    };
  });

  return {
    companies,
    totals: {
      companies: companies.length,
      activeCompanies: companies.filter((c) => c.status === "active").length,
      users: companies.reduce((sum, c) => sum + (c.users ?? 0), 0),
      openIssues: companies.reduce((sum, c) => sum + (c.openIssues ?? 0), 0),
    },
    latestActivity: companies.reduce<string | null>((acc, c) => latest(acc, c.lastActivity), null),
    fullCounts: companies.some((c) => c.jobs !== null || c.invoices !== null || c.lastActivity !== null),
    errorsRecorded: false,
  };
}
