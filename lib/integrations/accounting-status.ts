import type { IntegrationOverview } from "@/lib/integrations/overview";

export type AccountingStatus = {
  id: string; name: string; available: boolean; configuration: string; connection: string; mapping: string;
  /** Xero only: the company's own transfer switch (release 149), separate from Connected. OFF by default. */
  transfers: string;
  readiness: string; lastTransfer: string;
  /** Earlier failed or uncertain transfers, so a later success never hides them. */
  failures: string;
  updatedAt: string | null;
};
type SendRow = { status: string; updated_at?: string } | null;
const SEND_LABEL: Record<string, string> = { sent: "Succeeded", failed: "Failed", needs_check: "Needs checking", pending: "Waiting", sending: "Sending", skipped: "Not sent" };

function connectionLabel(o: IntegrationOverview | null | undefined): string {
  if (!o) return "Unknown";
  if (o.status === "connected") return "Connected";
  return o.status === "needs_reconnect" ? "Reconnect needed" : "Not connected";
}
function failureLabel(o: IntegrationOverview | null, last: SendRow, readOk: boolean): string {
  const failed = Number(o?.counts?.failed ?? 0), check = Number(o?.counts?.needs_check ?? 0);
  if (!readOk && !o) return "Unknown";
  const parts = [failed ? `${failed} failed` : null, check ? `${check} needs checking` : null].filter(Boolean);
  if (!parts.length && !last) return readOk ? "None recorded" : "Unknown";
  const when = last?.updated_at ? `, latest ${SEND_LABEL[last.status] ?? last.status} ${last.updated_at.slice(0, 10)}` : "";
  return parts.length ? parts.join(", ") + when : `${SEND_LABEL[last?.status ?? ""] ?? "Failure"} recorded${when}`;
}

/**
 * Local capability and readiness only. Never claims a live provider was tested or a transfer occurred from configuration alone.
 * `enabled` is the company's own Xero transfer switch (integration_xero_launch_status); null means it could not be read: Unknown, never On or Off.
 */
export function accountingStatuses(input: {
  configured: boolean | null; overview: IntegrationOverview | null; enabled: boolean | null;
  last: SendRow; lastReadOk: boolean;
  lastFailure?: SendRow; failureReadOk?: boolean;
  sage?: IntegrationOverview | null; quickbooks?: IntegrationOverview | null;
}): AccountingStatus[] {
  const o = input.overview;
  const connected = o?.status === "connected";
  const mapping = o ? (o.unmapped.length ? "Mapping outstanding" : "Mapped") : "Unknown";
  const transfers = input.enabled === null ? "Unknown" : input.enabled ? "On" : "Off";
  let readiness = "Not ready";
  if (input.configured === null || !o || input.enabled === null) readiness = "Unknown";
  else if (!input.enabled) readiness = "Transfers OFF";
  else if (input.configured && connected && !o.unmapped.length && !o.contact_problems) readiness = "Ready";
  const lastTransfer = input.lastReadOk ? (input.last ? SEND_LABEL[input.last.status] ?? "Unknown" : "No transfers recorded") : "Unknown";
  return [
    {
      id: "xero", name: "Xero", available: true,
      configuration: input.configured === null ? "Unknown" : input.configured ? "Configured" : "Needs configuration",
      connection: connectionLabel(o), mapping, transfers, readiness, lastTransfer,
      failures: failureLabel(o, input.lastFailure ?? null, input.failureReadOk ?? false),
      updatedAt: input.last?.updated_at ?? null,
    },
    {
      id: "sage-files", name: "Sage", available: true, configuration: "No invoice transfer is built",
      connection: input.sage === undefined ? "Unknown" : connectionLabel(input.sage) === "Connected" ? "Connected (read-only payment checks)" : connectionLabel(input.sage),
      mapping: "Accountant checks file mapping", transfers: "Not applicable", readiness: "File export only, no live link",
      lastTransfer: "No online transfers", failures: "Not applicable", updatedAt: null,
    },
    {
      id: "quickbooks", name: "QuickBooks", available: false, configuration: "No invoice transfer is built",
      connection: input.quickbooks === undefined ? "Unknown" : connectionLabel(input.quickbooks) === "Connected" ? "Connected (read-only payment checks)" : connectionLabel(input.quickbooks),
      mapping: "Not built", transfers: "Not applicable", readiness: "Not built: no invoices are sent",
      lastTransfer: "No online transfers", failures: "Not applicable", updatedAt: null,
    },
  ];
}
