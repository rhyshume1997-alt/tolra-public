/**
 * BOUNDARY: lib/platform/owner-home/flag.ts (Owner Home, module 12). Input: an env object (default process.env). Output: whether the
 * owner home screen at /platform is switched on. True only for exactly "true"; unset is OFF. Off means /platform is the existing
 * company list, unchanged. Must not read any other variable or have side effects.
 */
export const OWNER_HOME_FLAG = "PLATFORM_OWNER_HOME_ENABLED";

export function ownerHomeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[OWNER_HOME_FLAG] === "true";
}
