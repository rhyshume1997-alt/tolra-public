// What the Xero setup card says, worked out in one place (pure, so every state is unit tested). It never invents a state: the words
// follow what the SERVER does. With the transfer switch (release 149) a company sends only when it is connected AND mapped AND its own switch
// is ON; Connected is not On. With no `launchHold` input at all (the pure view with nothing wired) the words are the legacy ones: no switch
// exists, and a company that is connected AND mapped sends on every path.

import type { Activation, ConnectionTone, SetupStep } from "@/components/integrations/setup-card";
import { connectOutcomeMessage, type IntegrationOverview } from "@/lib/integrations/overview";

/**
 * The company's Xero transfer switch (release 149, GET/POST /api/integrations/xero/launch). `available`: the server answered (false: it could
 * not be read, so nothing is sent: the app fails closed). `on`: the switch (null while it is being read). Absent: no switch is wired (legacy words).
 */
export type LaunchHold = { available: boolean; on: boolean | null; set: (next: boolean) => Promise<void> | void };

export const HOLD_NOT_APPROVED = "Transfers cannot be switched on from here yet: the Xero launch hold (release 149) has not been approved.";
export const NOT_SET_UP = "Xero is not set up on this server: nothing is sent.";
export const SENDS_AUTOMATICALLY = "This company is connected and mapped: transfers happen automatically when invoices are issued.";
export const HELD_TEXT = "Connected is not On. Transfers are OFF for this company: nothing is sent to Xero until an admin turns transfers on below.";
export const TRANSFERS_ON_TEXT = "Transfers are ON for this company: documents are sent to Xero automatically when invoices are issued, and what is already waiting in the queue is sent too.";
export const HOLD_UNREADABLE = "Couldn't read the transfer switch, so nothing is sent: transfers stay off unless the switch is confirmed on. Reload to try again.";
export const EMERGENCY_NOTE = "Server emergency disable: removing Xero's app details from the server stops all sending to Xero, for every company, at once.";
export const TRANSFERS_NEED_MAPPING = "Transfers cannot be turned on while anything is unmapped.";

export type XeroInputs = {
  /** The status route's answer: are Xero's app details on this server? null while loading. */
  configured: boolean | null;
  /** integration_overview, or null while loading. */
  overview: IntegrationOverview | null;
  /** The overview could not be read. */
  loadError?: boolean;
  /** The ?xero= outcome the callback redirected with, if any. */
  outcome?: string | null;
  launchHold?: LaunchHold;
};

export type Behaviour = "loading" | "unknown" | "not_set_up" | "not_connected" | "needs_reconnect" | "unmapped" | "held" | "sends";

export function unmappedCount(o: Pick<IntegrationOverview, "unmapped"> | null): number {
  return o?.unmapped?.length ?? 0;
}

/** What the server will really do for this company right now. */
export function serverBehaviour(i: XeroInputs): { kind: Behaviour; text: string } {
  if (i.loadError) return { kind: "unknown", text: "Couldn't read Xero's status, so what is being sent is not known here. Try again." };
  if (i.configured === null || i.overview === null) return { kind: "loading", text: "Checking Xero's status…" };
  if (!i.configured) return { kind: "not_set_up", text: NOT_SET_UP };
  const o = i.overview;
  if (o.status === "needs_reconnect") return { kind: "needs_reconnect", text: "Xero needs this company to connect again. Nothing is sent until an admin does." };
  if (o.status !== "connected") return { kind: "not_connected", text: "This company is not connected to Xero: nothing is sent." };
  const n = unmappedCount(o);
  if (n > 0) return { kind: "unmapped", text: `This company is connected but ${n} ${n === 1 ? "item is" : "items are"} not mapped: nothing is sent until every one is mapped.` };
  const hold = i.launchHold;
  if (!hold) return { kind: "sends", text: SENDS_AUTOMATICALLY };
  if (!hold.available) return { kind: "unknown", text: HOLD_UNREADABLE };
  if (hold.on === null) return { kind: "loading", text: "Checking the transfer switch…" };
  return hold.on ? { kind: "sends", text: TRANSFERS_ON_TEXT } : { kind: "held", text: HELD_TEXT };
}

export function connectionLine(i: XeroInputs): { tone: ConnectionTone; label: string } {
  const b = serverBehaviour(i).kind;
  if (b === "loading") return { tone: "working", label: "Checking…" };
  if (b === "unknown") return { tone: "attention", label: "Unknown: Xero's status could not be read" };
  if (b === "not_set_up") return { tone: "off", label: "Not available: Xero is not set up on this server" };
  const o = i.overview!;
  if (o.status === "needs_reconnect") return { tone: "attention", label: `Needs connecting again${o.tenant_name ? ` (was ${o.tenant_name})` : ""}` };
  if (o.status === "connected") return { tone: "ok", label: `Signed in to Xero${o.tenant_name ? `: ${o.tenant_name}` : ""}. Signed in is not the same as allowed to transfer.` };
  return { tone: "off", label: o.status === "disconnected" ? "Disconnected" : "Not signed in to Xero" };
}

export function setupSteps(i: XeroInputs): SetupStep[] {
  const o = i.overview;
  const connected = o?.status === "connected" && i.configured === true;
  const n = unmappedCount(o);
  const hold = i.launchHold;
  const on = hold?.available ? hold.on === true : false;
  const turnOnHint = !hold ? "Not available yet: the launch hold has not been approved." : !hold.available ? "The transfer switch could not be read, so transfers stay off." : "Off until an admin turns it on, with a fresh authenticator code. Connecting never turns it on.";
  return [
    { label: "Connect to Xero", state: connected ? "done" : "next" },
    { label: "Check the Xero organisation", state: connected ? "done" : "later", hint: connected && o?.tenant_name ? `${o.tenant_name}: connected to this company only.` : "Shows which Xero organisation this company is bound to." },
    { label: "Map accounts and VAT rates", state: !connected ? "later" : n === 0 ? "done" : "next", hint: connected ? (n === 0 ? "Everything in use is mapped." : `${n} unmapped. ${TRANSFERS_NEED_MAPPING}`) : TRANSFERS_NEED_MAPPING },
    { label: "Turn on transfers", state: on ? "done" : connected && n === 0 && hold?.available ? "next" : "later", hint: hold?.available && on ? undefined : turnOnHint },
  ];
}

/** The separate activation switch. Absent launch hold (this candidate): ALWAYS disabled, with the plain reason, and the state it shows is the TRUE server behaviour. */
export function activationFor(i: XeroInputs, busy = false, onChange?: (next: boolean) => void): Activation {
  const label = "Turn on transfers";
  const hold = i.launchHold;
  const b = serverBehaviour(i).kind;
  if (!hold) {
    // No hold on the server: nothing here can switch anything. "On" is shown only when the server really does send.
    const on = b === "sends" ? true : b === "loading" || b === "unknown" ? null : false;
    return { label, on, disabledReason: HOLD_NOT_APPROVED, help: "In this release there is no separate switch on the server: transfers follow the connection and the mapping." };
  }
  // Unreadable: the app fails closed (nothing is sent), so "off" is the true state here, never "unknown" and never "on".
  if (!hold.available) return { label, on: false, disabledReason: "The Xero launch hold is not available on this server yet, so transfers cannot be switched on from here." };
  // Eligible to turn ON: connected and mapped with Xero set up (the behaviour is then 'held' (off) or 'sends' (on)).
  const eligible = b === "sends" || b === "held";
  const turningOn = hold.on !== true;
  const reason = turningOn && !eligible
    ? b === "unmapped" ? TRANSFERS_NEED_MAPPING : b === "needs_reconnect" ? "Connect to Xero again first." : b === "not_connected" ? "Connect to Xero first." : b === "not_set_up" ? NOT_SET_UP : "Checking Xero's status…"
    : null;
  return { label, on: hold.on, busy, disabledReason: reason, onChange, help: "Off until an admin turns it on, with a fresh authenticator code. Connecting, reconnecting or a new consent never turns it on (and switches it off again). Turning it on also sends what is already waiting in the queue." };
}

/** The ?xero= outcome as an alert/status line for the card, or null. Tenant held by another company is a plain error. */
export function outcomeNotice(outcome: string | null | undefined): { tone: "ok" | "error"; text: string } | null {
  if (!outcome || outcome === "not_configured") return null;
  if (outcome === "connected") return { tone: "ok", text: connectOutcomeMessage(outcome) };
  return { tone: "error", text: outcome === "tenant_in_use" ? `${connectOutcomeMessage(outcome)} Each Xero organisation can belong to one Tolra company. Disconnect it there first, or choose a different organisation.` : connectOutcomeMessage(outcome) };
}
