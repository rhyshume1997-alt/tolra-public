/* eslint-disable @typescript-eslint/no-explicit-any */
// Loose types for the plain-JavaScript modules, so the tests that import them type-check.
export const JOBS_CANONICAL: Record<string, Record<string, { type: string; required: boolean; blankOk?: boolean }>>;
export const JOB_FILE_KINDS: string[];
export const JOB_IDENTIFIER_FIELDS: Set<string>;
export function readMappingRaw(idOrPath: string, profile?: any): any;
export function getJobsProfile(raw: any): any;
export function getHeaderCheck(raw: any): { strict: boolean; ignore: Record<string, Set<string>> };
export function compareHeaders(columns: any, canonical: any, headers: string[], ignore?: Set<string>): { missing: { field: string; columns: string[] }[]; unknown: string[]; twice: string[] };
export function describeHeaderProblems(list: any[]): string;
