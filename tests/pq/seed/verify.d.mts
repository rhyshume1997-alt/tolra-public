import type { PqDb } from "./guard.mjs";
export function verifyLoaded(db: PqDb, dataset: unknown): Promise<{ ok: boolean; results: { name: string; ok: boolean; expected: unknown; actual: unknown }[] }>;
