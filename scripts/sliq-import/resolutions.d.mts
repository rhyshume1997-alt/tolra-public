/* eslint-disable @typescript-eslint/no-explicit-any */
// Loose types for the plain-JavaScript modules, so the tests that import them type-check.
export const RESOLUTION_FORMAT: string;
export const DECISIONS: string[];
export function loadResolutions(file: string): { file: string; sha256: string; entries: any[]; customerMatches: any[]; customerNames: any[]; jobLinks: any[] };
export function resolveCreditNotes(opts: any): any;
