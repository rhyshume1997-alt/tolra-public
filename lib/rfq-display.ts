/**
 * The RFQ card's display definition: the single list of fields the card shows, in the order it shows them.
 * The RFQ page renders from rfqCardFields(); the Columns picker and Settings > Display list rfqPickerColumns()
 * (stored under the "rfq" key of hiddenColumns, the same storage the table pages use).
 * Locked fields are always shown and are not in the picker (like Selection and Actions on the tables).
 */
export const RFQ_DISPLAY_KEY = "rfq";

export type RfqFieldGroup = "title" | "body" | "meta";
export type RfqCardField = { key: string; label: string; group: RfqFieldGroup; locked?: boolean };

export const RFQ_CARD_FIELDS: RfqCardField[] = [
  // The card's title. RFQs have no number of their own; the customer names the card, and the quote reference sits in Stage.
  { key: "customer", label: "Customer", group: "title", locked: true },
  { key: "status", label: "Status", group: "title" },
  { key: "stage", label: "Stage", group: "title" },
  { key: "description", label: "Description", group: "body" },
  { key: "value", label: "Value", group: "meta" },
  { key: "received", label: "Received", group: "meta" },
  // View, Reply, Forward, Clarify and Quote buttons.
  { key: "actions", label: "Actions", group: "meta", locked: true },
];

/** The fields to render, in definition order, minus the ticked-off ones (locked fields cannot be hidden). */
export function rfqCardFields(hidden: readonly string[] = []): RfqCardField[] {
  return RFQ_CARD_FIELDS.filter((field) => field.locked || !hidden.includes(field.key));
}

/** What the Columns picker lists: the fields that can be switched off. */
export function rfqPickerColumns(): { key: string; label: string }[] {
  return RFQ_CARD_FIELDS.filter((field) => !field.locked).map(({ key, label }) => ({ key, label }));
}
