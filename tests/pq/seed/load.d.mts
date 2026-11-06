import type { PqDb } from "./guard.mjs";
export function poundsOf(pence: number): string;
export type LoadedCompany = { kind: string; orgId: string; slug: string; users: Record<string, { id: string; email: string; role: string }> };
export function loadPqDataset(
  db: PqDb,
  dataset: unknown,
  options: { createUser: (user: { email: string; fullName: string; role: string }) => Promise<string>; log?: (line: string) => void },
): Promise<{ companies: LoadedCompany[]; notes: string[] }>;
