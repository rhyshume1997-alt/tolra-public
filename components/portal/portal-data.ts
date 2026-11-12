import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import { portalCookieName } from "@/lib/portal/cookie";
import { portalEnabled } from "@/lib/portal/flag";
import { resolvePortalSession } from "@/lib/portal/server";
import type { PortalPermission, PortalSession } from "@/lib/portal/types";

/**
 * BOUNDARY: components/portal/portal-data.ts (server only, used by app/portal pages). Output of portalGate(): 404 when the platform
 * flag is off (checked first, before any cookie or database use); otherwise the cookie token, or null when there is none.
 * portalSession(): the resolved session, or null for ANY refusal (the page then shows the one generic refusal and the sign-in form).
 * Must not return the refusal's correlation id to the page, or decide anything the database decides.
 */
export function portalGate(): void {
  if (!portalEnabled()) notFound();
}

export async function portalToken(): Promise<string | null> {
  return (await cookies()).get(portalCookieName())?.value ?? null;
}

export async function portalSession(): Promise<{ token: string; session: PortalSession } | null> {
  portalGate();
  const token = await portalToken();
  if (!token) return null;
  const result = await resolvePortalSession(token);
  return result.ok ? { token, session: result.data } : null;
}

export const hasPermission = (session: PortalSession, permission: PortalPermission): boolean => session.permissions.includes(permission);
