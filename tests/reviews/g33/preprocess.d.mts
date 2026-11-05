/** Synthetic rehearsal API only. */
export function parseCsv(text: string): string[][];
export function preprocess(text: string, opts: { kind: string; invoicesClean?: string }): {
  files: Record<string, string>;
  flags: { code: string }[];
  counts: Record<string, number>;
  reconciliation: Record<string, { equal: boolean }>;
};
