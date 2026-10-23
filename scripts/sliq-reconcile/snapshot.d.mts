/* eslint-disable @typescript-eslint/no-explicit-any */
// Loose types for the plain-JavaScript modules, so the tests that import them type-check.
export const SNAPSHOT_FORMAT: string;
export class SnapshotError extends Error { problems: any[] }
export const TABLES: Record<string, any>;
export const SNAPSHOT_TABLES: string[];
export function buildSnapshot(raw: any, label: string): any;
export function loadSnapshot(target: string): Promise<{ snapshot: any; files: { file: string; sha256: string; bytes: number }[] }>;
