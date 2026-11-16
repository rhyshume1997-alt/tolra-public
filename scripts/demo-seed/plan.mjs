/**
 * The clearly fake "Tolra Demo" company for screenshots (JOB U). Pure data and guards: nothing here touches a database.
 * No real names, emails, phone numbers or prices: every name says Example/Demo, every email is @example.test, every amount is a round number.
 */
export const DEMO_SLUG = "tolra-demo";
export const DEMO_NAME = "Tolra Demo";
export const DEMO_ADMIN_EMAIL = "demo.admin@example.test";
export const THROWAWAY_FLAG = "--yes-this-is-a-throwaway-database";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Refuses anything but an explicit flag plus loopback database and API addresses. Throws an Error with a plain reason. */
export function assertThrowaway({ argv = [], env = {} } = {}) {
  if (!argv.includes(THROWAWAY_FLAG)) throw new Error(`Refusing: pass ${THROWAWAY_FLAG} to confirm this is a throwaway or local database.`);
  for (const key of ["TEST_DATABASE_URL", "TEST_SUPABASE_URL"]) {
    const raw = env[key];
    if (!raw) throw new Error(`Refusing: ${key} is not set (run scripts/test-backend.sh start first).`);
    let host;
    try {
      host = new URL(raw).hostname;
    } catch {
      throw new Error(`Refusing: ${key} is not a URL.`);
    }
    if (!LOOPBACK.has(host)) throw new Error(`Refusing: ${key} points at ${host}, not this machine.`);
  }
  if (!env.TEST_SUPABASE_SERVICE_ROLE_KEY) throw new Error("Refusing: TEST_SUPABASE_SERVICE_ROLE_KEY is not set.");
}

const day = (today, offset) => {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset));
  return d.toISOString().slice(0, 10);
};

/** Everything the seed writes, relative to `today` (a Date). */
export function planDemoData(today = new Date()) {
  const customers = ["A", "B", "C"].map((letter) => ({ name: `Example Customer ${letter}`, email: `customer.${letter.toLowerCase()}@example.test` }));
  const line = (description, quantity, unit_price) => ({ description, quantity, unit_price });
  const invoices = [
    { invoice_ref: "DEMO-INV-001", customer: customers[0].name, invoice_date: day(today, -45), due_date: day(today, -15), status: "sent", lines: [line("Example part", 10, 10)], state: "paid" },
    { invoice_ref: "DEMO-INV-002", customer: customers[1].name, invoice_date: day(today, -5), due_date: day(today, 25), status: "sent", lines: [line("Example part", 5, 20)], state: "due" },
    { invoice_ref: "DEMO-INV-003", customer: customers[2].name, invoice_date: day(today, -60), due_date: day(today, -30), status: "sent", lines: [line("Example part", 4, 25)], state: "overdue" },
    { invoice_ref: "DEMO-INV-004", customer: customers[0].name, invoice_date: day(today, -3), due_date: day(today, 27), status: "sent", lines: [line("Example part", 2, 50)], state: "due" },
  ];
  const payments = [{ invoice_ref: "DEMO-INV-001", paid_on: day(today, -20), amount: 120, method: "BACS" }];
  const jobs = [
    { job_no: "DEMO-001", customer: customers[0].name },
    { job_no: "DEMO-002", customer: customers[1].name },
    { job_no: "DEMO-003", customer: customers[2].name },
  ];
  const machines = [{ name: "Demo Mill" }, { name: "Demo Lathe" }];
  // Hours before "now" for the demo time on the first two jobs: a labour session and a machine run each.
  const times = [
    { job: "DEMO-001", machine: "Demo Mill", labourStartHoursAgo: 7, labourStopHoursAgo: 4, runStartHoursAgo: 6, runStopHoursAgo: 4.5 },
    { job: "DEMO-002", machine: "Demo Lathe", labourStartHoursAgo: 3.5, labourStopHoursAgo: 2, runStartHoursAgo: 3, runStopHoursAgo: 2.25 },
  ];
  const profile = {
    documentName: DEMO_NAME,
    addressLines: ["1 Example Street", "Exampleton", "EX1 1EX"],
    phone: "01000 000000",
    email: "demo@example.test",
    vatRegistered: true,
    vatNumber: "GB 000 0000 00",
    defaultVatRate: 20,
    brandedLogin: false,
    loginTagline: "Demo company for screenshots. Not real.",
  };
  return { customers, invoices, payments, jobs, machines, times, profile };
}

/** The JSON the data-import function takes (customers, invoices, payments). */
export function importPayload(plan, runLabel = "demo-seed") {
  return {
    file_name: `${runLabel}.xlsx`,
    file_sha256: "d".repeat(64),
    customers: plan.customers.map(({ name }) => ({ name })),
    invoices: plan.invoices.map(({ state: _state, ...inv }) => inv),
    payments: plan.payments,
  };
}
