/* eslint-disable @typescript-eslint/no-explicit-any */
// Loose types for the plain-JavaScript modules, so the tests that import them type-check.
export class UsageError extends Error {}
export const EXIT: { OK: number; UNEXPECTED: number; INPUT: number; REFUSED: number; BLOCKERS: number; NOT_PASS: number };
export function main(argv: string[], io?: { stdout?: (t: string) => void; stderr?: (t: string) => void }, opts?: { generatedAt?: string }): Promise<number>;
