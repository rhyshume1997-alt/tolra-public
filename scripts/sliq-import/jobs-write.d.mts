/* eslint-disable @typescript-eslint/no-explicit-any */
// Loose types for the plain-JavaScript modules, so the tests that import them type-check.
export function readJobsTarget(db: any, organizationId: string, jobsLoaded: any): Promise<any>;
export function readJobsTargetReadOnly(databaseUrl: string, organizationId: string, jobsLoaded: any): Promise<any>;
export function prepareJobsWrite(db: any, organizationId: string, opts: any): Promise<{ report: any; addToExport(json: any): void; finish(): Promise<any> }>;
