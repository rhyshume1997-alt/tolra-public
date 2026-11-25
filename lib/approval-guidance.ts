/**
 * Approval Queue banner guidance. Inputs: none. Output: the one guidance string rendered by BOTH the legacy page and the redesign.
 * Must not change: keep it as a single constant so the two views can never drift; tests pin every sentence.
 */
export const APPROVAL_GUIDANCE =
  "Check each draft before sending. Chase reminders can be approved and sent here when email sending is set up. Customer statements and system-created invoice drafts also offer Approve and send in Full preview when a provider is configured. To send a draft yourself, copy it or open it in your email app, then choose Mark as Sent Manually after you have sent it.";
