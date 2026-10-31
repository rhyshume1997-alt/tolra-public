/**
 * The AI section's master switch ("AI on/off" for the company), as a pure mapping so the page and its tests agree.
 *
 * A company has up to three AI features: the round-up, RFQ e-mail to draft quote, and the pre-issue finance check. The master switch
 * is not a fourth stored value: it is "all of them" (on), "none of them" (off) or somewhere between ("Some features on"). Turning it
 * on or off writes every feature together. `financeCheck` is null while the database has no per-company finance-check column
 * (migration 106 not applied yet): that feature is then left out of the sum, shown as not available, and never written.
 */
export type AiFeatureStates = { roundup: boolean; rfq: boolean; financeCheck: boolean | null };
export type MasterState = "on" | "off" | "partial";

export const AI_FEATURE_KEYS = ["roundup", "rfq", "financeCheck"] as const;
export type AiFeatureKey = (typeof AI_FEATURE_KEYS)[number];

/** The features that exist for this company (the finance check only once the database can hold its switch). */
export function availableFeatures(states: AiFeatureStates): AiFeatureKey[] {
  return AI_FEATURE_KEYS.filter((key) => states[key] !== null);
}

export function masterState(states: AiFeatureStates): MasterState {
  const keys = availableFeatures(states);
  const on = keys.filter((key) => states[key] === true).length;
  if (on === 0) return "off";
  return on === keys.length ? "on" : "partial";
}

export function masterLabel(state: MasterState): string {
  return state === "on" ? "AI is on" : state === "off" ? "AI is off" : "Some features on";
}

/** The master switch flipped: every available feature takes the same value; an unavailable one stays unavailable. */
export function applyMaster(states: AiFeatureStates, on: boolean): AiFeatureStates {
  return { roundup: on, rfq: on, financeCheck: states.financeCheck === null ? null : on };
}

/** What the settings route is sent. `financeCheckEnabled` is left out when the database cannot hold it. */
export function settingsBody(states: AiFeatureStates, monthlyCapPence: number) {
  return {
    roundupEnabled: states.roundup,
    rfqEnabled: states.rfq,
    ...(states.financeCheck === null ? {} : { financeCheckEnabled: states.financeCheck }),
    monthlyCapPence,
  };
}
