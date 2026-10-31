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
  ["/numbers", ["admin"]],
  ["/settings", ["admin"]],
  // The AI section (office and admin): a sidebar item only while the server has AI_HELPER_ENABLED on (see aiNavAvailable).
  ["/ai-helper", ["admin", "office"]],
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

/** The AI section's menu item exists only when this server has the AI helper on (AI_HELPER_ENABLED, handed to the browser as a boolean). */
export function aiNavAvailable(href: string, aiHelperOn: boolean): boolean {
  return href !== "/ai-helper" || aiHelperOn;
}
