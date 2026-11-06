import type { PqDb } from "./guard.mjs";
export function findPqRuns(db: PqDb): Promise<Map<string, string[]>>;
export function resetPqData(db: PqDb, options?: { runId?: string | null }): Promise<{ runs: number; organizations: number; users: number }>;
export function pqLeftovers(db: PqDb): Promise<Record<string, number>>;
