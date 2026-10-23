/* eslint-disable @typescript-eslint/no-explicit-any */
// Loose types for the plain-JavaScript modules, so the tests that import them type-check.
export const REPORT_FORMAT: string;
export const LIMITATIONS: string[];
export function summarise(rows: any[], ctx: any): any;
export function renderMarkdown(summary: any, rows: any[]): string;
export function csvFiles(rows: any[]): Record<string, string>;
export const sha: (text: string) => string;
