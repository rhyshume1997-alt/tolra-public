/**
 * Loads the signed-in company's people by name, for every surface that says who did something (Job Board assignee, photos,
 * worksheet who/when, rework, activity; the Machine Schedule can call it too). One path, one rule (lib/people.ts peopleMap):
 * display name, then username, then "—"; never an e-mail address. withUsernames is the schedule sweep's helper (same file, same
 * signature), so both branches resolve names the same way.
 *
 * company_people() (migration 035) is readable by every role and gives display names only. An admin can also read usernames
 * (org_members(), admin only), so for an admin a person with no display name falls back to their username. For the other roles
 * that fallback needs company_people() to return the username too (a database change; not made here).
 */
import { type PeopleMap, peopleMap, withUsernames } from "@/lib/people";

type Rpc = { rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> };

/** True when the profile can read org_members() (admin as the main or second role). */
export const canReadUsernames = (profile: { role?: string | null; secondary_role?: string | null } | null | undefined) =>
  profile?.role === "admin" || profile?.secondary_role === "admin";

/** The people map, or null when company_people() couldn't be read (offline): callers keep what they had. */
export async function loadCompanyPeople(client: Rpc | null | undefined, options: { usernames?: boolean } = {}): Promise<PeopleMap | null> {
  if (!client) return null;
  const [who, members] = await Promise.all([
    client.rpc("company_people"),
    options.usernames ? client.rpc("org_members") : Promise.resolve({ data: null, error: null }),
  ]);
  if (who.error) return null;
  const people = peopleMap(who.data);
  return options.usernames && !members.error ? withUsernames(people, members.data) : people;
}
