import { featureStates, type AiHelperStatus } from "@/components/ai-helper/use-ai-helper-status";
import type { ConnectionTone, SetupStep } from "@/components/integrations/setup-card";
import { applyMaster, settingsBody } from "@/lib/ai-helper/master-switch";
import type { SendAnswer } from "@/lib/mfa-step-up";

/**
 * Admin > Integrations > AI: what the card shows and sends, as plain functions so the card and its tests agree. No secrets here: the key
 * only ever passes through `postJson` (one request body, never stored, logged or echoed back).
 *
 * The only providers that exist in code are Anthropic with the company's OWN key and Tolra-provided AI (Tolra's platform key, a per-company
 * monthly allowance). Nothing else is offered.
 */
export type AiProvider = "anthropic" | "tolra";

/** The official Anthropic Console page where a key is made. Shown as link text only. */
export const ANTHROPIC_KEYS_URL = "https://console.anthropic.com/settings/keys";

/** The same shape app/api/ai-helper/key checks (form only: the first request tells whether Anthropic accepts it). */
const KEY_SHAPE = /^sk-ant-[A-Za-z0-9_-]{20,200}$/;
export const KEY_SHAPE_MESSAGE = "That doesn't look like an Anthropic API key (it starts with sk-ant-).";
export function keyLooksRight(value: string): boolean {
  return KEY_SHAPE.test(value.trim());
}

/** Pence as pounds and pence, e.g. 1000 -> "£10.00". The number always comes from the server. */
export function poundsAndPence(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

export const SERVER_OFF_REASON = "AI is switched off on this server (the AI_HELPER_ENABLED setting), so it can't be turned on here.";
export const TOLRA_OFF_REASON = "Tolra has switched provided AI off, so it can't be turned on.";
export const NO_KEY_REASON = "Save your Anthropic key first. AI can't be turned on without one.";
export const NOT_ADMIN_REASON = "Only an admin can change AI.";
export const STATUS_ERROR_REASON = "Couldn't read the AI status. Try again in a moment.";

export type AssistantLine = { state: "on" | "off" | "unavailable"; text: string };

export type AiSetupModel = {
  provider: AiProvider;
  serverOff: boolean;
  connection: { tone: ConnectionTone; label: string };
  steps: SetupStep[];
  /** null = unknown (loading or unreadable). */
  on: boolean | null;
  /** Why AI cannot be TURNED ON now. Never set while AI is on, so the person can always turn it off. */
  disabledReason: string | null;
  help: string;
  capLine: string | null;
  assistant: AssistantLine | null;
  footnote: string;
  keySaved: boolean;
};

export type AiSetupInput = { serverOn: boolean; loaded: boolean; status: AiHelperStatus | null; chosen: AiProvider };

/** What the server says is in use wins over the picker: Tolra-provided AI is on only when the server says so. */
export function effectiveProvider(status: AiHelperStatus | null, chosen: AiProvider): AiProvider {
  return status?.tolra_enabled ? "tolra" : chosen;
}

/** AI is "on" when any feature runs (round-up, RFQ or the assistant), or Tolra-provided AI is on. */
export function aiIsOn(status: AiHelperStatus): boolean {
  return Boolean(status.tolra_enabled || status.roundup_enabled || status.rfq_enabled || (status.assistant_available && status.assistant_enabled));
}

export function buildAiSetup(input: AiSetupInput): AiSetupModel {
  const { serverOn, loaded, status } = input;
  const provider = effectiveProvider(status, input.chosen);
  const footnote = "AI is switched off for the whole server by the AI_HELPER_ENABLED setting (and the assistant by AI_ASSISTANT_ENABLED). If either is off here, it can't be turned on from this card. Saving a key never turns AI on.";
  const base = { provider, footnote, keySaved: false, capLine: null as string | null, assistant: null as AssistantLine | null };

  if (!serverOn) {
    return { ...base, serverOff: true, connection: { tone: "attention", label: "AI is switched off on this server" }, on: false, disabledReason: SERVER_OFF_REASON,
      steps: [{ label: "Server switch", state: "next", hint: "AI is off for this server. Nothing here can change that." }], help: "" };
  }
  if (!loaded) {
    return { ...base, serverOff: false, connection: { tone: "working", label: "Checking…" }, on: null, disabledReason: "Loading the AI status.", steps: [], help: "" };
  }
  if (!status) {
    return { ...base, serverOff: false, connection: { tone: "attention", label: "Couldn't read the AI status" }, on: null, disabledReason: STATUS_ERROR_REASON, steps: [], help: "" };
  }

  const on = aiIsOn(status);
  const assistant: AssistantLine = !status.assistant_available
    ? { state: "unavailable", text: "Assistant: not available on this server" }
    : status.assistant_enabled ? { state: "on", text: "Assistant: on" } : { state: "off", text: "Assistant: off" };

  let disabledReason: string | null = null;
  if (!on) {
    if (!status.can_manage) disabledReason = NOT_ADMIN_REASON;
    else if (provider === "tolra" ? !status.tolra_available : !status.key_set) disabledReason = provider === "tolra" ? TOLRA_OFF_REASON : NO_KEY_REASON;
  }

  if (provider === "tolra") {
    const cap = typeof status.tolra_cap_pence === "number" ? poundsAndPence(status.tolra_cap_pence) : null;
    return {
      ...base, serverOff: false, assistant, on, disabledReason, keySaved: status.key_set,
      connection: status.tolra_available ? { tone: "ok", label: "Tolra-provided AI is available" } : { tone: "attention", label: "Tolra has switched provided AI off" },
      steps: [
        { label: "Choose Tolra-provided AI", state: "done" },
        { label: "Check your monthly allowance", state: status.tolra_available ? "done" : "next" },
        { label: "Turn on AI", state: on ? "done" : disabledReason ? "later" : "next" },
      ],
      capLine: cap ? `Monthly allowance (Tolra-provided): ${cap} a month, per company. Used this month: ${poundsAndPence(status.month_spent_pence)}.` : "Monthly allowance: set by Tolra for your company.",
      help: "Uses Tolra's own AI account, not yours. Everything it does counts towards your company's monthly allowance, and it stops when that is used up.",
    };
  }

  const last4 = status.key_last4 ? ` (ending ${status.key_last4})` : "";
  return {
    ...base, serverOff: false, assistant, on, disabledReason, keySaved: status.key_set,
    connection: status.key_set ? { tone: "ok", label: `Key saved${last4}` } : { tone: "off", label: "No key saved" },
    steps: [
      { label: "Choose Anthropic with your own key", state: "done" },
      { label: "Get a key from Anthropic", state: status.key_set ? "done" : "next", hint: "Make the key in an Anthropic account your business owns, and set a spend limit there too." },
      { label: "Paste and save the key", state: status.key_set ? "done" : "later" },
      { label: "Turn on AI", state: on ? "done" : disabledReason ? "later" : "next", hint: "A separate step. Saving a key never turns AI on." },
    ],
    capLine: `Monthly limit (your own key): ${poundsAndPence(status.monthly_cap_pence)} a month. Used this month: ${poundsAndPence(status.month_spent_pence)}.`,
    help: "Uses your company's own Anthropic account and key. Everything it does counts towards your monthly limit, and it stops when that is reached.",
  };
}

/** The request that turns AI on or off for the chosen provider. Switching on is sent through sendWithCode (a fresh authenticator code). */
export function switchRequest(provider: AiProvider, status: AiHelperStatus, on: boolean): { path: string; body: unknown } {
  if (provider === "tolra") return { path: "/api/ai-helper/tolra-mode", body: { enabled: on } };
  return { path: "/api/ai-helper/settings", body: settingsBody(applyMaster(featureStates(status), on), status.monthly_cap_pence) };
}

type JsonBody = { code?: unknown; error?: unknown };

/** What the card says after the key was saved, replaced or removed. A key change switches AI off (release 150), so a company that had AI on is told so. */
export type KeyChange = "saved" | "replaced" | "removed";
export function keyChangeNotice(change: KeyChange, wasOn: boolean): string {
  const lead = change === "removed" ? "Key removed." : change === "replaced" ? "New key saved. It replaces the old key, which is no longer used." : "Key saved.";
  if (wasOn) return `${lead} AI was switched off because the key changed. Turn it on again with the switch above when you are ready.`;
  return change === "removed" ? `${lead} AI stays off until you turn it on with the switch above.` : `${lead} AI is not turned on by saving a key.`;
}

/** One JSON POST as the signed-in person, answered in the shape sendWithCode needs. Never throws; the body is not kept anywhere. */
export async function postJson(path: string, body: unknown, fetchFn: typeof fetch = fetch): Promise<SendAnswer<JsonBody & Partial<AiHelperStatus>>> {
  return requestJson("POST", path, body, fetchFn);
}

/** The same for POST or DELETE (removing the key sends no body). */
export async function requestJson(method: "POST" | "DELETE", path: string, body: unknown, fetchFn: typeof fetch = fetch): Promise<SendAnswer<JsonBody & Partial<AiHelperStatus>>> {
  try {
    const response = await fetchFn(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: "no-store" });
    const parsed = (await response.json().catch(() => null)) as (JsonBody & Partial<AiHelperStatus>) | null;
    return { ok: response.ok, status: response.status, body: parsed };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

/** A message safe to show: the route's own sentence when it has one that does not contain the secret, else a plain fallback. */
export function safeMessage(body: { error?: unknown } | null | undefined, fallback: string, secret?: string): string {
  const message = body?.error;
  if (typeof message !== "string" || !message || message.length > 200) return fallback;
  if (secret && secret.length >= 8 && message.includes(secret)) return fallback;
  return message;
}
