/* eslint-disable @typescript-eslint/no-explicit-any */
// Loose types for the plain-JavaScript modules, so the tests that import them type-check.
export const REPORT_FORMAT: string;
export function analyse(loaded: any, opts?: any): { report: any; plan: any };
export function renderMarkdown(report: any): string;
export function renderAmbiguityCsv(report: any): string;
export function exactName(name: string): string;
export function numberCopies(rows: any[], kind: string, dateField: string): { rows: any[]; log: any[]; duplicated: Set<string> };
