/**
 * What the app knows about the signed-in session's company (migration 036, public.my_session()). The database decides; this only
 * reads the answer so the app can route (company picker, platform page), show the support banner and keep support sessions
 * off the offline store.
 */

export type SessionInfo = {
  user_id: string;
  organization_id: string | null;
  organization_name: string | null;
  role: string | null;
  secondary_role: string | null;
  hidden_sections: string[];
  /** The platform owner working inside a company through a support membership. */
  support: boolean;
  /** Support without write access (never elevated, or the elevation has ended). */
  read_only: boolean;
  support_expires_at: string | null;
  elevated_until: string | null;
  platform_admin: boolean;
  /** How many companies the person belongs to in their own right (support access is not counted). */
  organization_count: number;
  /** No company is chosen for this session yet, and there is something to choose. */
  needs_choice: boolean;
};

const text = (value: unknown) => (typeof value === "string" && value ? value : null);

/** Reads the answer of my_session(); anything that isn't an object with a user id is no session. */
export function parseSessionInfo(raw: unknown): SessionInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.user_id !== "string") return null;
  return {
    user_id: row.user_id,
    organization_id: text(row.organization_id),
    organization_name: text(row.organization_name),
    role: text(row.role),
    secondary_role: text(row.secondary_role),
    hidden_sections: Array.isArray(row.hidden_sections) ? row.hidden_sections.filter((s): s is string => typeof s === "string") : [],
    support: row.support === true,
    read_only: row.read_only === true,
    support_expires_at: text(row.support_expires_at),
    elevated_until: text(row.elevated_until),
    platform_admin: row.platform_admin === true,
    organization_count: typeof row.organization_count === "number" ? row.organization_count : 0,
    needs_choice: row.needs_choice === true,
  };
}

/** HH:MM in UK time. */
export function clockTime(value: string | Date, timeZone = "Europe/London") {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(typeof value === "string" ? new Date(value) : value);
}

/** The banner shown for the whole of a support session; null for everyone else. */
export function supportBanner(info: SessionInfo | null): string | null {
  if (!info?.support) return null;
  const company = info.organization_name ?? "this company";
  const expires = info.support_expires_at ? `, expires ${clockTime(info.support_expires_at)}` : "";
  if (info.read_only) return `Support access to ${company}, read-only${expires}`;
  const write = info.elevated_until ? `write access until ${clockTime(info.elevated_until)}` : "write access";
  return `Support access to ${company}, ${write}${expires}`;
}

/** Nothing from a support session is kept on the device. */
export const offlineCopyAllowed = (info: SessionInfo | null) => !info?.support;

/**
 * Where a signed-in session must go before it may use any business page, or null when it may carry on. A platform owner always
 * picks a company first; a person with several companies chooses one for each sign-in; a person with one goes straight in.
 */
export function companyStepRoute(info: SessionInfo | null, path: string): string | null {
  if (!info) return null;
  const onPlatform = path === "/platform" || path.startsWith("/platform/");
  const onPicker = path === "/choose-company" || path.startsWith("/choose-company/");
  if (!info.organization_id) {
    if (info.platform_admin) return onPlatform ? null : "/platform";
    if (info.needs_choice) return onPicker ? null : "/choose-company";
    return null;
  }
  // In a company already: the platform page is for the platform owner only; the picker is open to anyone who has a choice.
  if (onPlatform && !info.platform_admin) return "/dashboard";
  if (onPicker && info.organization_count < 1) return "/dashboard";
  return null;
}
