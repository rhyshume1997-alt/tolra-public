"use client";

/** Resolves presentation markers from the current company's confirmed server settings. Unconfirmed settings resolve to OFF. */
import { useConfirmedCompanyNavigation, useOrgSettings } from "@/lib/org-settings";
import { useUser } from "@/lib/use-user";

export function useCompanyUiSwitch(marker: string, requiredFeature?: string) {
  const navigation = useConfirmedCompanyNavigation();
  const settings = useOrgSettings();
  const { profile, user } = useUser();

  return Boolean(
    settings.loaded &&
    !settings.localOnly &&
    navigation &&
    navigation.organizationId === profile?.organization_id &&
    navigation.userId === user?.id &&
    navigation.hiddenNav.includes(marker) &&
    (!requiredFeature || (
      navigation.hiddenNav.includes(requiredFeature) &&
      settings.hiddenNav.includes(requiredFeature)
    ))
  );
}
