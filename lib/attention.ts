/** What the dashboard's "Needs Your Attention" card may say. An all-clear is only honest when every read behind it worked. */
export type AttentionState = "incomplete" | "clear" | "items";

/** `failed` is true when any query that feeds the list came back with an error. */
export function attentionState(itemCount: number, failed: boolean): AttentionState {
  if (itemCount > 0) return failed ? "incomplete" : "items";
  return failed ? "incomplete" : "clear";
}
