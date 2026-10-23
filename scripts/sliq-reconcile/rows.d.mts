/* eslint-disable @typescript-eslint/no-explicit-any */
// Loose types for the plain-JavaScript modules, so the tests that import them type-check.
export const SEVERITIES: string[];
export const CSV_COLUMNS: string[];
export const AREAS: string[];
export const NOT_SUPPLIED: string;
export const UNKNOWN: string;
export const NONE: string;
export const P: (p: number | null | undefined) => string;
export const Q: (m: number | null | undefined) => string;
export const ids: (obj: Record<string, any>) => string;
export function makeCollector(): { rows: any[]; add(r: any): void };
export function sortRows(rows: any[]): any[];
