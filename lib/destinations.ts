import { MEMBER_SECTIONS, sectionForPath } from "@/lib/sections";
import type { UserRole } from "@/types";

/**
 * Which pages a shortcut (bell, dashboard tile, menu link) may point at. One rule for every visible link: it is
 * shown only when the page would really open for the person, in the view they are working in.
 *
 * A destination opens when
 * - the active view's role is allowed on it (the role view switcher decides what is on screen; the middleware
 *   checks the person's real roles, and the active view is always one of them), and
 * - an admin has not hidden that section from this person (Admin > Users > Page access), and
 * - the company has not hidden it from the menu (Settings > Menu).
 *
 * The middleware and the database stay the real gate; this only stops the interface offering a link that would
 * end in "Access denied" or a "blocked" redirect.
 */
const FIXED_ROLES: Array<[string, UserRole[]]> = [
  ["/dashboard", ["admin", "office", "workshop", "viewer"]],
  ["/admin", ["admin"]],
  ["/settings", ["admin"]],
  // The daily job sheet and weekly hours (050 to 052): not a hideable section (no member_section_keys() entry).
  ["/time", ["admin", "office", "workshop"]],
];

export type DestinationAccess = {
  activeRole: UserRole;
  hiddenSections: readonly string[];
  hiddenNav?: readonly string[];
};

function rolesFor(href: string): UserRole[] | null {
  const fixed = FIXED_ROLES.find(([prefix]) => href === prefix || href.startsWith(`${prefix}/`));
  if (fixed) return fixed[1];
  const section = MEMBER_SECTIONS.find((item) => href === item.href || href.startsWith(`${item.href}/`));
  return section ? section.roles : null;
}

export function canOpenDestination(target: string, access: DestinationAccess): boolean {
  // A link may carry a query or fragment ("/quotes?filter=expired"): access depends on the page only.
  const href = target.split(/[?#]/)[0];
  const roles = rolesFor(href);
  if (!roles || !roles.includes(access.activeRole)) return false;
  const section = sectionForPath(href);
  if (section && access.hiddenSections.includes(section)) return false;
  if (access.hiddenNav && href !== "/dashboard" && href !== "/settings" && access.hiddenNav.includes(href.replace(/^\//, ""))) return false;
  return true;
}
