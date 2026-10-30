import { accessSignal } from "@/lib/offline/access";

/**
 * Open tabs share one browser session, and switch_organization / the company settings change what that session sees. A tab that did
 * not do the change would otherwise keep the old company's profile (name, VAT, bank details on a printed document) and the old
 * company's pages until a full reload. The tab that made the change tells the others through localStorage (the `storage` event fires
 * in every other tab, never in the writer), and every tab also asks the server again on focus / when it becomes visible
 * (lib/use-user.ts recheck).
 */
export const COMPANY_CHANGED_KEY = "tolra-company-changed";

/** Tells the other open tabs that this company's settings (company details, logo, colours) changed: they reload their copy. */
export function announceCompanyChanged() {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(COMPANY_CHANGED_KEY, `${Date.now()}-${Math.random().toString(36).slice(2)}`); } catch { /* they refresh on their next load */ }
}

export type TabSignal = "end" | "recheck" | "refresh-company" | null;

/** What a storage event from another tab asks of this one. */
export function tabSignal(event: { key: string | null; newValue: string | null }, userId: string | null): TabSignal {
  if (!userId) return null;
  if (event.key === COMPANY_CHANGED_KEY && event.newValue) return "refresh-company";
  return accessSignal(event, userId);
}

/**
 * The server now answers for another company than the one this tab is showing, and the person has a role there: another tab switched
 * company. This tab must not go on with the old company's profile and pages (a form submitted here would be filed under the new
 * company with the old company's context), so it follows the switch (reload at the dashboard).
 */
export function companyChangedElsewhere(liveOrgId: string | null | undefined, now: { organization_id: string | null; role: string | null }): boolean {
  return !!liveOrgId && !!now.organization_id && !!now.role && now.organization_id !== liveOrgId;
}

type StorageTarget = {
  addEventListener: (type: "storage", listener: (event: StorageEvent) => void) => void;
  removeEventListener: (type: "storage", listener: (event: StorageEvent) => void) => void;
};

/** Listens for the other tabs' signals. Returns the function that stops listening. */
export function listenForTabSignals(
  target: StorageTarget,
  handlers: { userId: () => string | null; skip: () => boolean; onSignal: (signal: Exclude<TabSignal, null>) => void },
): () => void {
  const onStorage = (event: StorageEvent) => {
    if (handlers.skip()) return;
    const signal = tabSignal(event, handlers.userId());
    if (signal) handlers.onSignal(signal);
  };
  target.addEventListener("storage", onStorage);
  return () => target.removeEventListener("storage", onStorage);
}
