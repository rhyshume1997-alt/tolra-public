"use client";

import { useCallback, useEffect, useState } from "react";

import { type AiFeatureStates } from "@/lib/ai-helper/master-switch";
import { useAiFeatures } from "@/components/ai-features";
import { useUser } from "@/lib/use-user";

export type AiHelperStatus = {
  roundup_enabled: boolean;
  rfq_enabled: boolean;
  monthly_cap_pence: number;
  key_set: boolean;
  key_last4: string | null;
  month_spent_pence: number;
  month_reserved_pence: number;
  can_manage: boolean;
  /** The company's finance-check switch and whether the database can hold it (migration 106). Missing from an older answer = not available. */
  finance_check_enabled?: boolean;
  finance_check_available?: boolean;
  /** The company's assistant switch and whether this server and database offer it (G3, migration 133). Missing = not available. */
  assistant_enabled?: boolean;
  assistant_available?: boolean;
  /** Set by the settings route when the other settings were saved but the finance-check switch could not be changed. */
  warning?: string;
};

/**
 * The company's AI helper state, read from the server (GET /api/ai-helper/status, as the person) only when this server has the helper
 * on and the person is working as office or admin. Null while loading, when off, or on any error: every AI UI then stays hidden.
 */
export function useAiHelperStatus() {
  const { aiHelper } = useAiFeatures();
  const { profile, activeRole } = useUser();
  const allowed = Boolean(aiHelper && profile && (activeRole === "admin" || activeRole === "office"));
  const [status, setStatus] = useState<AiHelperStatus | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!allowed) {
      setStatus(null);
      setLoaded(true);
      return;
    }
    try {
      const response = await fetch("/api/ai-helper/status", { cache: "no-store" });
      setStatus(response.ok ? ((await response.json()) as AiHelperStatus) : null);
    } catch {
      setStatus(null);
    } finally {
      setLoaded(true);
    }
  }, [allowed]);

  useEffect(() => { void reload(); }, [reload]);

  return { status, loaded, allowed, reload, setStatus };
}

export const anyFeatureOn = (status: AiHelperStatus | null) => Boolean(status && (status.roundup_enabled || status.rfq_enabled || (status.assistant_available && status.assistant_enabled)));

/** The status as the feature switches. The finance check and the assistant are null (not available) until they can be used. */
export function featureStates(status: AiHelperStatus): AiFeatureStates {
  return { roundup: status.roundup_enabled, rfq: status.rfq_enabled, financeCheck: status.finance_check_available ? status.finance_check_enabled === true : null,
    assistant: status.assistant_available ? status.assistant_enabled === true : null };
}
