/** A delete that asked for the deleted rows back (`.select("id")`) only worked if exactly one row came back. Zero means someone changed it first. */
export function deletedOne(rows: unknown): boolean {
  return Array.isArray(rows) && rows.length === 1;
}
