/**
 * After an invoice or credit note is issued, or an invoice voided (G22): asks the server to send THAT document to Xero, best effort,
 * whoever issued it (only its first attempt: retries and resends are an admin's, Admin > Integrations). The document is already queued
 * by the database; nothing here waits for Xero or can make the issue fail, and when Xero is not set up, or the company not connected,
 * the server does nothing. Anything not sent now goes on an admin's Send now or the daily sweep.
 */
export function nudgeIntegrationSend(docType: "invoice" | "credit_note", docId: string): void {
  if (typeof window === "undefined" || typeof fetch !== "function" || !docId) return;
  try {
    void fetch("/api/integrations/xero/after-issue", {
      method: "POST", credentials: "same-origin", keepalive: true, headers: { "content-type": "application/json" },
      body: JSON.stringify({ doc_type: docType, doc_id: docId }),
    }).catch(() => undefined);
  } catch {
    // Never let the nudge disturb the page.
  }
}
