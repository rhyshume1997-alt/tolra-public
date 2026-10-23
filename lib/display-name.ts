/**
 * Display names. Everyone who works in a company should have one: the Job Board, the who-did-what lines and the schedule
 * show people by name from company_people() (migration 035), which treats an empty name, or one that looks like an e-mail
 * address, as no name at all ("—"). The name lives in user_profiles.full_name; a signed-in person may edit their own row
 * (policy "Users update own profile", migration 000; the profile guard leaves full_name free), and an admin may edit the
 * profiles of their company's members (policy "Admins update org members", migration 007). No new SQL.
 * Pure helpers: no browser or Supabase here.
 */

/** What the Job Board shows for an assignee with no usable name, instead of a bare "—". */
export const NAME_NOT_SET = "(name not set)";

/** The longest name shown anywhere (company_people() cuts at 80). */
export const DISPLAY_NAME_MAX = 80;

/** Same rule as company_people(): trimmed, not empty, and no "@". */
export function hasDisplayName(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("@");
}

/** Why a typed name can't be saved, or null when it can. */
export function displayNameProblem(value: string): string | null {
  const name = value.trim();
  if (!name) return "Enter your name.";
  if (name.includes("@")) return "Use a name, not an email address.";
  if (name.length > DISPLAY_NAME_MAX) return `Keep the name to ${DISPLAY_NAME_MAX} characters or fewer.`;
  return null;
}

/** The value to store: trimmed, inner runs of spaces made single. */
export function normaliseDisplayName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * Whether to ask the signed-in person for a name: only when they have none, and never in a platform support session (the
 * support login is not one of the company's staff, and a read-only session couldn't save it anyway).
 */
export function shouldPromptForName(input: { fullName: unknown; support?: boolean | null }): boolean {
  if (input.support) return false;
  return !hasDisplayName(input.fullName);
}

/** How many of the listed people have no usable name (support logins aside). */
export function countMissingNames(rows: { fullName: unknown; support?: boolean }[]): number {
  return rows.filter((row) => !row.support && !hasDisplayName(row.fullName)).length;
}
