/* eslint-disable @typescript-eslint/no-explicit-any */
// Loose types for the plain-JavaScript modules, so the tests that import them type-check.
export function dryRun(opts: any): Promise<{ report: any; plan: any; loaded: any }>;
export function writeRun(opts: any): Promise<any>;
