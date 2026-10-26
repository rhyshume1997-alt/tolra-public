"use client";

import { createContext, useContext } from "react";

/**
 * Which AI features this server has switched on, as plain booleans from the dashboard layout (server side; the env var itself never
 * reaches the browser). Everything defaults to off, so a page rendered outside the provider shows no AI UI.
 */
export type AiFeatures = { financeCheck: boolean };

const AiFeaturesContext = createContext<AiFeatures>({ financeCheck: false });

export function AiFeaturesProvider({ value, children }: { value: AiFeatures; children?: React.ReactNode }) {
  return <AiFeaturesContext.Provider value={value}>{children}</AiFeaturesContext.Provider>;
}

export function useAiFeatures(): AiFeatures {
  return useContext(AiFeaturesContext);
}
