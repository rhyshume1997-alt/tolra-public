/* eslint-disable @typescript-eslint/no-explicit-any */
// Loose types for the plain-JavaScript modules, so the tests that import them type-check.
export class MappingError extends Error { problems: any[] }
export const CANONICAL: Record<string, any>;
export const FILE_KINDS: any[];
export const IDENTIFIER_FIELDS: Set<string>;
export function normHeader(h: any): string;
export function getProfile(idOrPath: string): any;
export function checkMapping(profile: any, found: any): any[];
export function describeProblems(profile: any, problems: any[]): string;
export function unmappedColumns(profile: any, kind: string, headers: string[]): string[];
