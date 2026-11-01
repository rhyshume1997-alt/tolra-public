// What Admin > Integrations shows (G22), from migration 084's integration_overview (no secret in it). Pure, so it is unit tested.

export type IntegrationOverview = {
  provider: string;
  status: "not_connected" | "connected" | "needs_reconnect" | "disconnected";
  tenant_name: string | null;
  connected_at: string | null;
  status_reason: string | null;
  /** "account:sales", "account:credit", "vat:<key>". */
  unmapped: string[];
  counts: Partial<Record<"pending" | "sending" | "sent" | "failed" | "needs_check" | "skipped", number>>;
  contact_problems: number;
};

const STATUS: Record<IntegrationOverview["status"], string> = {
  not_connected: "Not connected",
  connected: "Connected",
  needs_reconnect: "Needs connecting again",
  disconnected: "Disconnected",
};

/** A Tolra VAT key as people say it. */
export function vatKeyLabel(key: string): string {
  if (key === "exempt") return "Exempt";
  if (key === "no_vat") return "No VAT";
  return `${key}%`;
}

function unmappedLabel(unmapped: string[]): string | null {
  if (!unmapped.length) return null;
  const parts = unmapped.map((u) => (u === "account:sales" ? "the sales account" : u === "account:credit" ? "the credit note account" : u.startsWith("vat:") ? `VAT ${vatKeyLabel(u.slice(4))}` : u));
  return `Nothing is sent until these are mapped: ${parts.join(", ")}.`;
}

export function overviewSummary(o: IntegrationOverview): { statusLabel: string; unmappedLabel: string | null; countsLabel: string | null } {
  const c = o.counts ?? {};
  const bits = [
    c.sent ? `${c.sent} sent` : null,
    c.pending || c.sending ? `${(c.pending ?? 0) + (c.sending ?? 0)} waiting` : null,
    c.failed ? `${c.failed} failed` : null,
    c.needs_check ? `${c.needs_check} to check in Xero` : null,
    c.skipped ? `${c.skipped} not sent` : null,
    o.contact_problems ? `${o.contact_problems} customer${o.contact_problems === 1 ? "" : "s"} to match by hand` : null,
  ].filter(Boolean);
  return {
    statusLabel: STATUS[o.status] ?? o.status,
    unmappedLabel: o.status === "not_connected" || o.status === "disconnected" ? null : unmappedLabel(o.unmapped ?? []),
    countsLabel: bits.length ? `Send log: ${bits.join(", ")}.` : null,
  };
}

/** The message for the callback's ?xero= outcome (the callback never puts a token, code or state in it). */
export function connectOutcomeMessage(outcome: string): string {
  switch (outcome) {
    case "connected": return "All connected: Xero.";
    case "cancelled": return "Connecting to Xero was cancelled. Nothing changed.";
    case "expired": return "That Connect took too long or was started elsewhere. Click Connect to Xero again.";
    case "choose_one": return "Choose one Xero organisation only. Click Connect to Xero again and tick one.";
    case "no_organisation": return "No Xero organisation was chosen. Click Connect to Xero again.";
    case "tenant_in_use": return "That Xero organisation is already connected to another company in Tolra.";
    case "disconnect_first": return "This company is connected to another Xero organisation. Disconnect it first.";
    case "not_configured": return "Xero is not set up on this server yet.";
    case "forbidden": return "Only an admin who has confirmed their authenticator code can connect Xero.";
    case "signed_out": return "Sign in again, then connect Xero.";
    default: return "Connecting to Xero didn't work. Nothing changed. Try again.";
  }
}

/** The status line's words on Admin > Integrations (107): "All connected" once connected (Rhys, Fri 30 Oct), otherwise as overviewSummary. */
export function cardStatusLabel(o: Pick<IntegrationOverview, "status">, provider: "xero" | "microsoft" = "xero"): string {
  if (o.status === "connected") return "All connected";
  // Microsoft 365's own words, so the page never shows "Not connected" twice (the Xero card's line).
  if (provider === "microsoft" && o.status === "not_connected") return "No mailbox connected";
  return STATUS[o.status] ?? o.status;
}

/** What the page says when the app details are missing (Connect stays disabled until the platform owner enters them). */
export function notSetUpMessage(provider: "xero" | "microsoft"): string {
  return `Not set up yet: the owner must enter the ${provider === "xero" ? "Xero" : "Microsoft 365"} app details.`;
}

/** Shown in place of what needs migration 107 while it is not applied (the Xero card keeps working as before). */
export const NEEDS_107 = "Not available until database update 107 is applied.";

/** The message for the Microsoft 365 callback's ?microsoft= outcome (never a token, code or state in it). */
export function microsoftOutcomeMessage(outcome: string): string {
  switch (outcome) {
    case "connected": return "All connected: Microsoft 365.";
    case "cancelled": return "Connecting Microsoft 365 was cancelled. Nothing changed.";
    case "refused": return "Microsoft refused the sign-in (the app may need admin consent in that Microsoft 365 tenant). Nothing changed.";
    case "expired": return "That Connect took too long or was started elsewhere. Click Connect Microsoft 365 again.";
    case "mailbox_in_use": return "That mailbox is already connected to another company in Tolra.";
    case "disconnect_first": return "This company is connected to another mailbox. Disconnect it first.";
    case "no_mailbox": return "That Microsoft account has no mailbox. Sign in with an account that has one.";
    case "not_configured": return notSetUpMessage("microsoft");
    case "forbidden": return "Only an admin who has confirmed their authenticator code can connect Microsoft 365.";
    case "signed_out": return "Sign in again, then connect Microsoft 365.";
    default: return "Connecting Microsoft 365 didn't work. Nothing changed. Try again.";
  }
}
