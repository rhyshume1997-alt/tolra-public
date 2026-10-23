/* eslint-disable @typescript-eslint/no-explicit-any */
// Loose types for the plain-JavaScript modules, so the tests that import them type-check.
export function readTarget(db: any, organizationId: string, loaded: any): Promise<any>;
export function readTargetReadOnly(databaseUrl: string, organizationId: string, loaded: any): Promise<any>;
export function prepareRehearsal(databaseUrl: string): Promise<string>;
export function buildLegacyExport(plan: any, organizationId: string): any;
export function writeImport(opts: any): Promise<any>;
