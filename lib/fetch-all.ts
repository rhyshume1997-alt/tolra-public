/**
 * Loads every row of a list, page by page (audit D10). The API returns at most a fixed number of rows per request
 * (1,000 on hosted Supabase); without paging, older records silently vanish from lists, totals and exports.
 *
 * - Pages are requested with a stable order (the caller's order plus id as tie-breaker) and continue until an empty
 *   page, so a server cap smaller than our page size can't end the loop early.
 * - Rows are de-duplicated by id: a record inserted while paging can shift a row onto the next page.
 * - A hard upper bound keeps the browser responsive; reaching it is reported (truncated = true), never silent.
 */
export const MAX_LIST_ROWS = 20_000;
const PAGE_SIZE = 1_000;

type Page<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

export async function fetchAll<T extends Record<string, unknown>>(
  page: (from: number, to: number) => Page<T>,
  options: { pageSize?: number; maxRows?: number } = {},
): Promise<{ rows: T[]; truncated: boolean }> {
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const maxRows = options.maxRows ?? MAX_LIST_ROWS;
  const rows: T[] = [];
  const seen = new Set<unknown>();
  let offset = 0;
  for (;;) {
    const { data, error } = await page(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!data?.length) return { rows, truncated: false };
    for (const row of data) {
      const key = row.id ?? JSON.stringify(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
      if (rows.length >= maxRows) return { rows, truncated: true };
    }
    offset += data.length;
  }
}

export const truncationNotice = (count: number) =>
  `Showing the newest ${count.toLocaleString("en-GB")} records only. Older records exist but aren't listed here.`;
