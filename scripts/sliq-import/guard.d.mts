/* eslint-disable @typescript-eslint/no-explicit-any */
// Loose types for the plain-JavaScript modules, so the tests that import them type-check.
export class GuardError extends Error {}
export const PROD_REF: string;
export function redactUrl(url: string): string;
export function checkDatabaseUrl(url: any): { host: string; database: string };
export function checkOrganisationId(id: any): string;
export function loadReportFile(path: any): any;
export function assertWriteAllowed(opts: any): any;
