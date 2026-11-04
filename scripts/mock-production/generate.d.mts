export type MockCompany = {
  label: string; folder: string;
  counts: { customers: number; suppliers: number; jobs: number; purchaseOrders: number; invoices: number; payments: number };
  totals: { netPence: number; vatPence: number; grossPence: number; paymentsPence: number; outstandingPence: number; purchaseOrdersPence: number };
};
export function generateMockProduction(outDir: string, count?: number): {
  format: string; fakeOnly: boolean; databaseWrites: number; asOf: string; companies: MockCompany[];
};
