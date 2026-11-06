/** The slice of a pg Client the PQ tooling uses (a real Client satisfies it; so does a recording fake). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PqDb = { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, any>[]; rowCount?: number | null }> };
export const PRODUCTION_PROJECT_REFS: string[];
export const SYNTHETIC_SLUG_PREFIX: string;
export const CONFIRM_FLAG: string;
export class PqIsolationError extends Error {}
export function assertLoopbackUrl(name: string, value: string | undefined, env?: Record<string, string | undefined>): string;
export function assertLocalKey(name: string, value: string | undefined): string;
export function assertConfirmed(argv: string[]): void;
export function verifyDisposableIdentity(db: PqDb): Promise<{ database: string; serverVersion: string; migrations: string[]; organizations: number }>;
export function backendFromEnv(env?: Record<string, string | undefined>): { databaseUrl: string; apiUrl: string | null; serviceRoleKey: string | null };
