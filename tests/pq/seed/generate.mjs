/**
 * Deterministic synthetic "JNR" company for the PQ environment. PURE: no database, no network, no clock, no Math.random.
 *
 *   generatePqDataset({ seed, baseDate, scale }) -> plain JSON (same arguments -> byte-identical JSON.stringify)
 *
 * Everything is invented. Money is integer pence throughout (loader converts to pounds at the edge). Every date and timestamp is
 * derived from `baseDate` (YYYY-MM-DD, required) by whole-day offsets, so moving baseDate by N days moves every date by N days
 * (exactly, when N is a multiple of 7: working-day logic looks at the weekday). The only wall-clock use in this folder is the CLI's
 * default for baseDate, which is recorded in meta.baseDate.
 *
 * Totals follow the database's own rule (check_document_totals, migration 030): line net = round(qty x unit price, 2),
 * line VAT = round(line net x VAT% / 100, 2) half-up, document total = net + VAT; carriage is optional and may carry VAT.
 */
import { hashHex8, makeRng } from "./prng.mjs";

export const GENERATOR_VERSION = "tolra-pq-seed/1";
export const EMAIL_DOMAIN = "example.test";
export const VAT_RATE = 20;
export const MAX_SCALE = 50;

const DAY_MS = 86_400_000;

// ---- pence arithmetic -------------------------------------------------------------------------------------------------------
/** Half-up percentage of a non-negative integer pence amount: round(pence x pct / 100). */
export const pctOf = (pence, pct) => Math.floor((pence * pct + 50) / 100);
export const lineNet = (line) => line.quantity * line.unitPence;
export const lineVat = (line) => (line.vatExempt ? 0 : pctOf(lineNet(line), line.vatPct));

export function documentTotals(lines, { vatEnabled = true, carriagePence = 0, carriageVat = false } = {}) {
  const netPence = lines.reduce((sum, line) => sum + lineNet(line), 0);
  const lineVatPence = vatEnabled ? lines.reduce((sum, line) => sum + lineVat(line), 0) : 0;
  const vatPence = lineVatPence + (vatEnabled && carriageVat ? pctOf(carriagePence, VAT_RATE) : 0);
  return { netPence, carriagePence, vatPence, totalPence: netPence + carriagePence + vatPence };
}

// ---- dates --------------------------------------------------------------------------------------------------------------------
function parseBase(baseDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(baseDate));
  if (!m) throw new Error(`baseDate must be YYYY-MM-DD, got ${JSON.stringify(baseDate)}`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (new Date(ms).toISOString().slice(0, 10) !== baseDate) throw new Error(`baseDate is not a real date: ${baseDate}`);
  return ms;
}
const makeCalendar = (baseMs) => ({
  date: (offset) => new Date(baseMs + offset * DAY_MS).toISOString().slice(0, 10),
  at: (offset, hh = 8, mm = 0) => new Date(baseMs + offset * DAY_MS + (hh * 60 + mm) * 60_000).toISOString().replace(".000Z", "Z"),
  weekday: (offset) => new Date(baseMs + offset * DAY_MS).getUTCDay(), // 0 Sun .. 6 Sat
});

// ---- word lists (all invented) ----------------------------------------------------------------------------------------------
const FIRST = ["Aldous", "Briony", "Caspian", "Delphine", "Evander", "Fenella", "Gideon", "Hesper", "Ivo", "Juniper", "Kestrel", "Linnea", "Magnus", "Nerys", "Orrin", "Perpetua", "Quillon", "Rowena", "Silas", "Tamsin", "Ulric", "Verity", "Wystan", "Xanthe", "Yorick", "Zelda"];
const LAST = ["Ashgrove", "Bellweather", "Cranmoor", "Dunmere", "Eastlake", "Fairbourne", "Grindlow", "Hartspring", "Ironside-Vale", "Jessamy", "Kettleby", "Longmarsh", "Merriweather", "Nethercott", "Oakhollow", "Pemberly", "Quarrington", "Ravensmoor", "Stannard", "Thistlewood", "Underhill", "Vexford", "Wrenfield", "Yarrowby"];
const CO_A = ["Brindlemoor", "Corvane", "Dunhollow", "Elmstrand", "Fernwick", "Gallowmere", "Hobsworth", "Inglenook", "Jarrowby", "Kilnbrook", "Lowrimount", "Marrowfield", "Nettlecombe", "Ormesby-Tarn", "Pellworth", "Quillhurst", "Rushmoor", "Skelbrae", "Tarnside", "Umberfield", "Valewick", "Whinmoor"];
const CO_B = ["Hydraulics", "Precision", "Fabrications", "Pumps", "Tooling", "Castings", "Controls", "Subsea", "Rail Components", "Dairy Systems", "Packaging", "Turbines", "Valves", "Marine", "Agri Engineering", "Plastics", "Fasteners", "Conveyors"];
const CO_SUFFIX = ["Ltd", "Limited", "plc", "& Sons", "Group Ltd", "(UK) Ltd", "LLP"];
const MATERIALS = ["EN8 bar", "EN24T bar", "316L stainless bar", "304 stainless plate", "6082-T6 aluminium plate", "7075 aluminium bar", "C101 copper rod", "PTFE rod", "Delrin acetal rod", "Mild steel flat", "Phosphor bronze bar", "Brass CZ121 hex"];
const PART_STEM = ["bush", "flange", "spindle", "manifold block", "clamp plate", "gland", "adaptor", "shaft", "hub", "bracket", "spacer", "valve body", "end cap", "bearing housing"];
const OPS = ["Turn", "Mill", "Bore", "Drill and tap", "Grind", "Deburr and finish", "Cut to length", "Face and centre"];
const SUPPLIERS = ["Quarryfield Metals (synthetic)", "Thornby Bar & Tube (synthetic)", "Wexcombe Steels (synthetic)"];
const MACHINE_DEFS = [
  { name: "CNC Mill A", type: "3-axis machining centre", hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5] },
  { name: "CNC Lathe B", type: "CNC turning centre", hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5] },
  { name: "5-Axis C", type: "5-axis machining centre", hoursPerDay: 7.5, workingDays: [1, 2, 3, 4] },
  { name: "Manual Lathe D", type: "Centre lathe", hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5] },
  { name: "Bandsaw E", type: "Horizontal bandsaw", hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5] },
  { name: "Surface Grinder F", type: "Surface grinder", hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5, 6] },
  { name: "CNC Mill G", type: "3-axis machining centre", hoursPerDay: 10, workingDays: [1, 2, 3, 4, 5] },
  { name: "CNC Lathe H", type: "CNC turning centre", hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5] },
];
/** Awkward but legal names (apostrophes, ampersands, accents, quotes, very long, SQL-looking, double spaces). Always present. */
const AWKWARD_NAMES = [
  "O'Brien-Nakamura T/A \"Quick\" Fabrications",
  "Smith & Sons (Engineering) Ltd.",
  "Müller–Østergaard Präzision GmbH (UK branch)",
  "Zoë's Café Equipment  Ltd",
  "Robert'); DROP TABLE customers;-- Ltd",
  "A",
  "The Extraordinarily Long-Winded Northern Counties Heavy Engineering, Fabrication, Machining and Associated Trades Cooperative Society Limited",
  "100% Hydraulic Ltd #2 / Unit 7",
];

function money(rng, low, high) {
  // log-uniform-ish unit price in pence, deliberately including awkward pennies
  const base = Math.round(Math.exp(Math.log(low) + rng.next() * (Math.log(high) - Math.log(low))));
  return rng.chance(0.4) ? base : Math.round(base / 5) * 5 || 5;
}

// ---- phones and addresses (reserved/fictional only) ---------------------------------------------------------------------------
const phoneOf = (rng) => {
  const kind = rng.int(0, 2);
  if (kind === 0) return `01632 960${String(rng.int(0, 999)).padStart(3, "0")}`; // Ofcom drama range
  if (kind === 1) return `020 7946 0${String(rng.int(0, 999)).padStart(3, "0")}`; // Ofcom drama range
  return `0161 496 0${String(rng.int(0, 999)).padStart(3, "0")}`; // Ofcom drama range
};
const mobileOf = (rng) => `07700 900${String(rng.int(0, 999)).padStart(3, "0")}`; // Ofcom drama range

function buildCompany({ kind, name, slug, runId, rng, cal, scale, reuse }) {
  const isPrimary = kind === "primary";
  const tag = (role, n) => `${role}${n}.${kind === "primary" ? "jnr" : "practice"}.${runId}@${EMAIL_DOMAIN}`;
  const person = () => `${rng.pick(FIRST)} ${rng.pick(LAST)}`;

  // ---- users: admin, office, workshop, viewer ----
  const counts = isPrimary ? { admin: 1, office: 1 + Math.floor(scale / 5), workshop: Math.min(10, 2 + Math.floor(scale / 3)), viewer: 1 } : { admin: 1, office: 1, workshop: 0, viewer: 1 };
  const users = [];
  for (const role of ["admin", "office", "workshop", "viewer"]) {
    for (let n = 1; n <= counts[role]; n += 1) users.push({ key: `${role}${n}`, role, email: tag(role, n), fullName: person() });
  }

  // ---- customers ----
  const customers = [];
  const addCustomer = (customerName, extra = {}) => {
    const n = customers.length + 1;
    customers.push({
      key: `c${String(n).padStart(3, "0")}`,
      name: customerName,
      contactName: person(),
      email: `purchasing.c${String(n).padStart(3, "0")}.${runId}@${EMAIL_DOMAIN}`,
      phone: phoneOf(rng),
      mobile: rng.chance(0.3) ? mobileOf(rng) : null,
      address: `${rng.int(1, 99)} Synthetic Row\nTesttown\nZZ${rng.int(1, 9)} ${rng.int(1, 9)}ZZ`,
      notes: "SYNTHETIC PQ DATA. Invented customer; not a real company.",
      archived: false,
      ...extra,
    });
    return customers[customers.length - 1];
  };
  if (reuse) {
    for (const reused of reuse.customerNames) addCustomer(reused);
  } else {
    for (const n of AWKWARD_NAMES) addCustomer(n);
    const first = addCustomer("Brindlemoor Hydraulics Ltd");
    // exact duplicate name (different contact) and near-duplicates a clerk might create
    addCustomer("Brindlemoor Hydraulics Ltd", { duplicateOf: first.key });
    addCustomer("BRINDLEMOOR HYDRAULICS LIMITED", { duplicateOf: first.key });
    addCustomer("Brindlemoor  Hydraulics Ltd", { duplicateOf: first.key });
    const wanted = 10 * scale;
    const used = new Set(customers.map((c) => c.name));
    let guard = 0;
    while (customers.length < wanted + AWKWARD_NAMES.length + 4 && guard < 5000) {
      guard += 1;
      const candidate = `${rng.pick(CO_A)} ${rng.pick(CO_B)} ${rng.pick(CO_SUFFIX)}`;
      if (!used.has(candidate)) {
        used.add(candidate);
        addCustomer(candidate);
      }
    }
    // one archived, one with no email or phone at all
    customers[customers.length - 1].archived = true;
    customers[customers.length - 2].email = null;
    customers[customers.length - 2].phone = null;
    customers[customers.length - 2].mobile = null;
  }
  const liveCustomers = customers.filter((c) => !c.archived);

  // ---- parts (stock) ----
  const parts = [];
  if (isPrimary) {
    for (let i = 1; i <= 12 * scale; i += 1) {
      const minLevel = rng.int(5, 60);
      parts.push({
        sku: `PQ-P-${String(i).padStart(4, "0")}`,
        material: `${rng.pick(MATERIALS)} ${rng.pick([12, 16, 20, 25, 32, 40, 50, 63, 80])}mm`,
        currentStock: rng.chance(0.2) ? rng.int(0, minLevel - 1 > 0 ? minLevel - 1 : 0) : rng.int(minLevel, minLevel * 6),
        minLevel,
        reorderQuantity: rng.pick([10, 20, 25, 50, 100]),
        preferredSupplier: rng.pick(SUPPLIERS),
        unitPricePence: money(rng, 90, 18_000),
        leadTimeDays: String(rng.pick([2, 3, 5, 10, 15])),
      });
    }
  }

  // ---- machines (working hours) ----
  const machines = [];
  if (isPrimary) {
    const n = Math.min(MACHINE_DEFS.length, 5 + Math.floor(scale / 4));
    MACHINE_DEFS.slice(0, n).forEach((def, i) => machines.push({ key: `m${i + 1}`, ...def, active: true }));
    machines.push({ key: `m${n + 1}`, name: "Old Capstan Z (retired)", type: "Capstan lathe", hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5], active: false });
  }
  const activeMachines = machines.filter((m) => m.active);

  // ---- quotes ----
  const quotes = [];
  const quoteTarget = isPrimary ? 24 * scale : 6;
  const statusPlan = (i) => {
    const r = (i * 7919) % 100; // spread statuses deterministically, independent of the rng stream
    if (r < 14) return "draft";
    if (r < 32) return "sent";
    if (r < 42) return "expired"; // status 'sent' with a valid_until already past (the app has no 'expired' status)
    if (r < 76) return "accepted";
    return "rejected";
  };
  // An accepted quote becomes a sales order, which holds ONE VAT rate (accept_quote refuses mixed rates: needs = sales_order_by_hand),
  // so accepted quotes carry no VAT-exempt lines; and it also refuses a quote whose per-line VAT rounding differs from one rounding of
  // the whole (needs = sales_order_by_hand), so their unit prices are whole multiples of 5p (20% of a 5p multiple is exact).
  // Other quotes and stand-alone invoices keep the awkward pennies and may mix rates.
  const makeLines = (min, max, allowExempt = true) => {
    const n = rng.int(min, max);
    return Array.from({ length: n }, () => {
      const exempt = rng.chance(0.08) && allowExempt;
      const line = {
        description: `${rng.pick(OPS)} ${rng.pick(PART_STEM)} (${rng.pick(MATERIALS)})`,
        partNumber: rng.chance(0.7) ? `PN-${rng.int(1000, 9999)}-${rng.pick(["A", "B", "C"])}` : null,
        ...(rng.chance(0.3) ? { quantity: rng.int(50, 500), unitPence: money(rng, 150, 3_500) } : { quantity: rng.int(1, 40), unitPence: money(rng, 150, 95_000) }),
        vatPct: exempt ? 0 : VAT_RATE,
        vatExempt: exempt,
      };
      if (!allowExempt) line.unitPence = Math.max(5, Math.round(line.unitPence / 5) * 5);
      return line;
    });
  };
  const usedPos = new Set();
  const newPo = () => {
    let po;
    do po = `PO-${rng.int(1000, 9999)}-${rng.pick(["KX", "LM", "NP", "RT", "WS"])}`;
    while (usedPos.has(po));
    usedPos.add(po);
    return po;
  };
  for (let i = 0; i < quoteTarget; i += 1) {
    const status = statusPlan(i);
    const customer = rng.pick(liveCustomers);
    const createdOffset = -rng.int(status === "accepted" || status === "rejected" ? 25 : 1, status === "expired" ? 170 : 150);
    const vatEnabled = !rng.chance(0.06);
    const lines = makeLines(1, 5, status !== "accepted");
    const validOffset = status === "expired" ? Math.min(createdOffset + 30, -3) : status === "sent" || status === "draft" ? Math.max(createdOffset + 30, 7) : createdOffset + 30;
    const q = {
      key: `q${String(i + 1).padStart(4, "0")}`,
      customerKey: customer.key,
      status: status === "expired" ? "sent" : status,
      shape: status,
      createdOn: cal.date(createdOffset),
      validUntil: cal.date(validOffset),
      customerPo: status === "accepted" ? (rng.chance(0.9) ? newPo() : null) : null,
      vatEnabled,
      description: `${rng.pick(PART_STEM)} batch for ${customer.name.slice(0, 40)}`,
      lines,
      ...documentTotals(lines, { vatEnabled }),
    };
    if (reuse && reuse.customerPos[i]) q.customerPo = status === "accepted" ? reuse.customerPos[i] : null;
    if (status === "accepted") {
      q.acceptedOn = cal.date(Math.min(createdOffset + rng.int(2, 12), -1));
      q.deliveryOn = cal.date(createdOffset + rng.int(20, 60));
    }
    quotes.push(q);
  }

  // ---- jobs: accepted quotes become sales order + job (accept_quote); a few jobs are made directly (incl. internal) ----
  const jobs = [];
  const accepted = quotes.filter((q) => q.shape === "accepted");
  accepted.forEach((q, i) => {
    const r = i % 10; // progress spread
    const progress = r < 4 ? "complete" : r < 7 ? "in_progress" : "not_started";
    jobs.push({ key: `j${String(jobs.length + 1).padStart(4, "0")}`, kind: "from_quote", quoteKey: q.key, customerKey: q.customerKey, description: q.description, requiredOn: q.deliveryOn, progress, quantityRequired: q.lines.reduce((s, l) => s + l.quantity, 0) });
  });
  if (isPrimary) {
    for (let i = 0; i < 4 * scale; i += 1) {
      const internal = i % 4 === 3;
      const customer = rng.pick(liveCustomers);
      jobs.push({
        key: `j${String(jobs.length + 1).padStart(4, "0")}`,
        kind: internal ? "internal" : "direct",
        quoteKey: null,
        customerKey: internal ? null : customer.key,
        description: internal ? `Internal: ${rng.pick(["fixture plate", "jaw set", "workholding block", "tool-setting gauge"])}` : `Repeat order: ${rng.pick(PART_STEM)} x${rng.int(5, 80)}`,
        requiredOn: cal.date(rng.int(-20, 45)),
        progress: ["not_started", "in_progress", "not_started"][i % 3],
        quantityRequired: rng.int(5, 80),
      });
    }
  }

  // ---- machine bookings: per machine a cursor over working days; non-overlapping by construction ----
  // Pass 1 completed work (all before the base date); pass 2 at most one started-not-complete booking per machine, starting on or
  // before the base date (the schedule draws such a booking from NOW, migration 042 booking_intervals, so its remainder is short
  // and planned work starts the working day after the base date); pass 3 planned work after the base date.
  const bookings = [];
  const cursors = new Map(activeMachines.map((m) => [m.key, -70]));
  const isWorking = (m, off) => m.workingDays.includes(cal.weekday(off));
  const nextWorking = (m, off) => { let o = off; while (!isWorking(m, o)) o += 1; return o; };
  const prevWorking = (m, off) => { let o = off; while (!isWorking(m, o)) o -= 1; return o; };
  const lastDay = (m, start, hours) => { let o = start; const days = Math.max(1, Math.ceil(hours / m.hoursPerDay)); for (let d = 1; d < days; d += 1) o = nextWorking(m, o + 1); return o; };
  const hoursFor = () => rng.pick([2, 3, 4, 5.5, 6, 8, 12, 16, 20]);
  const push = (job, machine, start, hours, hoursDone, status) =>
    bookings.push({ key: `b${bookings.length + 1}`, jobKey: job.key, machineKey: machine.key, startAt: cal.at(start, 8, 0), hours, hoursDone, status, notes: "SYNTHETIC PQ DATA" });
  if (activeMachines.length) {
    let n = 0;
    for (const job of jobs.filter((j) => j.progress === "complete")) {
      const machine = activeMachines[n++ % activeMachines.length];
      const hours = hoursFor();
      const start = nextWorking(machine, cursors.get(machine.key));
      const end = lastDay(machine, start, hours);
      if (end > -2) continue; // would run into the present: leave this completed job without a booking
      push(job, machine, start, hours, hours, "complete");
      cursors.set(machine.key, nextWorking(machine, end + 1));
    }
    const running = new Set();
    const live = jobs.filter((j) => j.progress === "in_progress");
    for (const job of live) {
      const machine = activeMachines.find((m) => !running.has(m.key));
      if (!machine) break;
      const start = Math.max(prevWorking(machine, 0), nextWorking(machine, cursors.get(machine.key)));
      if (start > 0) continue;
      const hours = Math.min(hoursFor(), machine.hoursPerDay);
      push(job, machine, start, hours, Math.max(0.5, Math.floor(hours / 2)), "running");
      running.add(machine.key);
      job.booked = true;
      cursors.set(machine.key, 1);
    }
    for (const m of activeMachines) cursors.set(m.key, Math.max(1, cursors.get(m.key)));
    let k = 0;
    for (const job of jobs.filter((j) => j.progress !== "complete" && !j.booked)) {
      if (job.progress === "not_started" && k % 4 === 3) { k += 1; continue; } // some jobs are not yet planned
      const machine = activeMachines[k++ % activeMachines.length];
      const hours = hoursFor();
      const start = nextWorking(machine, cursors.get(machine.key));
      push(job, machine, start, hours, 0, "booked");
      cursors.set(machine.key, nextWorking(machine, lastDay(machine, start, hours) + 1));
    }
  }
  for (const job of jobs) delete job.booked;

  // ---- delivery notes: completed quote jobs, most despatched (which drafts an invoice), some signed ----
  const deliveryNotes = [];
  jobs.filter((j) => j.kind === "from_quote" && j.progress === "complete").forEach((job, i) => {
    const q = quotes.find((x) => x.key === job.quoteKey);
    const shipOffset = -rng.int(2, 60);
    deliveryNotes.push({
      key: `d${String(i + 1).padStart(4, "0")}`,
      jobKey: job.key,
      quoteKey: q.key,
      shipDate: cal.date(shipOffset),
      shipVia: rng.pick(["Own van", "Pallet carrier (synthetic)", "Customer collection"]),
      signed: i % 3 === 0,
      notes: "SYNTHETIC PQ DATA",
      finishedOn: cal.date(shipOffset - rng.int(1, 5)),
    });
  });

  // ---- invoices ----
  const invoices = [];
  const paymentMethods = ["BACS", "BACS", "BACS", "cheque", "card", "cash", "other"];
  const pickState = (i) => ["issued_current", "issued_overdue", "part_paid", "paid", "paid", "credited", "draft", "part_paid_overdue"][i % 8];
  const offsetOf = (calendar, isoDate) => Math.round((Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${calendar.date(0)}T00:00:00Z`)) / DAY_MS);
  /** Gives an invoice its dates, payments and credit according to its state. No invoice is dated before `minOffset` (its delivery). */
  const finishInvoice = (inv, i, minOffset) => {
    const state = pickState(i);
    const rel = (low, high) => Math.min(-1, Math.max(minOffset, -rng.int(low, high)));
    const termsDays = rng.pick([14, 30, 30, 45]);
    const invoiceOffset = { issued_current: rel(1, 10), issued_overdue: rel(60, 140), part_paid: rel(5, 25), part_paid_overdue: rel(60, 130), paid: rel(8, 120), credited: rel(20, 100), draft: rel(0 + 1, 8) }[state];
    inv.shape = state;
    inv.invoiceDate = cal.date(invoiceOffset);
    inv.dueDate = cal.date(invoiceOffset + termsDays);
    inv.terms = `${termsDays} days`;
    inv.payments = [];
    inv.credit = null;
    inv.issue = state !== "draft";
    const total = inv.totalPence;
    const payOn = (off) => cal.date(Math.min(off, -1));
    const ref = () => `PQ-REF-${rng.int(10000, 99999)}`;
    if (state === "part_paid" || state === "part_paid_overdue") {
      const first = Math.max(1, Math.floor((total * rng.int(20, 70)) / 100));
      inv.payments.push({ paidOn: payOn(invoiceOffset + rng.int(1, 4)), amountPence: Math.min(first, total - 1), method: rng.pick(paymentMethods), reference: ref() });
    } else if (state === "paid") {
      const split = total > 1000 && rng.chance(0.35);
      const a = split ? Math.floor(total / 3) : total;
      inv.payments.push({ paidOn: payOn(invoiceOffset + rng.int(2, 7)), amountPence: a, method: rng.pick(paymentMethods), reference: ref() });
      if (split) inv.payments.push({ paidOn: payOn(invoiceOffset + rng.int(8, 20)), amountPence: total - a, method: rng.pick(paymentMethods), reference: ref() });
    } else if (state === "credited") {
      const line = inv.lines[0];
      const qty = line.quantity > 1 ? Math.max(1, Math.floor(line.quantity / 3)) : 1;
      const creditLine = { ...line, quantity: qty };
      const creditNet = lineNet(creditLine);
      const creditVat = inv.vatEnabled ? lineVat(creditLine) : 0;
      inv.credit = { lineIndex: 0, quantity: qty, reason: "Synthetic goods returned (PQ)", creditDate: cal.date(Math.min(invoiceOffset + rng.int(3, 15), -1)), netPence: creditNet, vatPence: creditVat, totalPence: creditNet + creditVat };
    }
    inv.paidPence = inv.payments.reduce((sum, p) => sum + p.amountPence, 0);
    inv.creditedPence = inv.credit ? inv.credit.totalPence : 0;
    inv.outstandingPence = inv.issue ? total - inv.paidPence - inv.creditedPence : 0;
    // overdue is a property of the dates against the base date
    inv.overdue = inv.issue && inv.outstandingPence > 0 && inv.dueDate < cal.date(0);
    invoices.push(inv);
    return inv;
  };
  let invoiceNo = 0;
  // invoices drafted by despatching a delivery note (the loader reads them back); lines are the quote's lines
  deliveryNotes.forEach((dn) => {
    const q = quotes.find((x) => x.key === dn.quoteKey);
    const inv = { key: `i${String(++invoiceNo).padStart(4, "0")}`, source: "delivery_note", deliveryNoteKey: dn.key, customerKey: q.customerKey, customerPo: q.customerPo, vatEnabled: q.vatEnabled, carriageVat: false, lines: q.lines, ...documentTotals(q.lines, { vatEnabled: q.vatEnabled }) };
    finishInvoice(inv, invoiceNo - 1, offsetOf(cal, dn.shipDate));
  });
  // stand-alone invoices (account customers, services, carriage)
  const standalone = isPrimary ? 28 * scale : 4;
  for (let i = 0; i < standalone; i += 1) {
    const customer = rng.pick(liveCustomers);
    const vatEnabled = !rng.chance(0.05);
    const lines = makeLines(1, 4);
    const carriagePence = rng.chance(0.3) ? rng.pick([850, 1250, 1500, 2495, 3500]) : 0;
    const carriageVat = carriagePence > 0 && rng.chance(0.8);
    const inv = { key: `i${String(++invoiceNo).padStart(4, "0")}`, source: "standalone", deliveryNoteKey: null, customerKey: customer.key, customerPo: rng.chance(0.7) ? newPo() : null, vatEnabled, carriageVat, lines, ...documentTotals(lines, { vatEnabled, carriagePence, carriageVat }) };
    finishInvoice(inv, invoiceNo - 1 + 3, -150);
  }
  // ---- attendance (time sheets) and labour on jobs: workshop and office users over recent working days ----
  const attendance = [];
  const labour = [];
  if (isPrimary) {
    const staff = users.filter((u) => u.role === "workshop" || u.role === "office");
    const days = [];
    for (let off = -1; days.length < 20 * Math.min(scale, 3) && off > -400; off -= 1) { const wd = cal.weekday(off); if (wd >= 1 && wd <= 5) days.push(off); }
    const inProgressJobs = jobs.filter((j) => j.progress !== "not_started" && j.kind !== "internal");
    staff.forEach((u, ui) => {
      days.forEach((off, di) => {
        const arriveMin = 7 * 60 + 30 + rng.int(0, 60) + (rng.chance(0.06) ? 45 : 0);
        const leaveMin = 16 * 60 + rng.int(0, 90);
        const breakStart = 12 * 60 + rng.int(0, 30);
        const breakEnd = breakStart + (rng.chance(0.15) ? 45 : 30);
        const hh = (m) => [Math.floor(m / 60), m % 60];
        const forgot = di === 4 + (ui % 3); // an occasional shift with no clock-out
        const events = [
          { action: "in", at: cal.at(off, ...hh(arriveMin)), opId: rng.uuid() },
          { action: "break_start", at: cal.at(off, ...hh(breakStart)), opId: rng.uuid() },
          { action: "break_end", at: cal.at(off, ...hh(breakEnd)), opId: rng.uuid() },
        ];
        if (!forgot) events.push({ action: "out", at: cal.at(off, ...hh(leaveMin)), opId: rng.uuid() });
        attendance.push({ userKey: u.key, day: cal.date(off), events, worked: forgot ? null : { minutes: leaveMin - arriveMin - (breakEnd - breakStart) } });
        if (u.role === "workshop" && inProgressJobs.length && !forgot) {
          const job = inProgressJobs[(ui + di) % inProgressJobs.length];
          const s = arriveMin + 15, e = Math.min(breakStart - 5, s + rng.int(60, 180));
          const s2 = breakEnd + 5, e2 = Math.min(leaveMin - 10, s2 + rng.int(60, 200));
          if (e > s) labour.push({ userKey: u.key, jobKey: job.key, startedAt: cal.at(off, ...hh(s)), endedAt: cal.at(off, ...hh(e)) });
          if (e2 > s2) labour.push({ userKey: u.key, jobKey: job.key, startedAt: cal.at(off, ...hh(s2)), endedAt: cal.at(off, ...hh(e2)) });
        }
      });
    });
  }

  return {
    name,
    slug,
    kind,
    profile: {
      documentName: name,
      addressLines: ["Unit 1, Synthetic Estate", "Testtown", "ZZ1 1ZZ"],
      phone: "01632 960001",
      email: `office1.${kind === "primary" ? "jnr" : "practice"}.${runId}@${EMAIL_DOMAIN}`,
      vatRegistered: true,
      vatNumber: "GB 000 0000 00",
      defaultVatRate: VAT_RATE,
      brandedLogin: false,
      loginTagline: "Synthetic PQ company. Not real.",
    },
    users,
    customers,
    parts,
    machines,
    quotes,
    jobs,
    bookings,
    deliveryNotes,
    invoices,
    attendance,
    labour,
  };
}

export function generatePqDataset({ seed = "pq-jnr-1", baseDate, scale = 1 } = {}) {
  if (!Number.isInteger(scale) || scale < 1 || scale > MAX_SCALE) throw new Error(`scale must be an integer 1..${MAX_SCALE}`);
  const baseMs = parseBase(baseDate);
  const cal = makeCalendar(baseMs);
  const runId = hashHex8(`${GENERATOR_VERSION}|${seed}`);
  const root = makeRng(`${GENERATOR_VERSION}|${seed}|${scale}`);
  const primary = buildCompany({ kind: "primary", name: `Synthetic JNR PQ ${runId}`, slug: `t-${runId}-jnr`, runId, rng: root.fork("primary"), cal, scale });
  const reuse = {
    customerNames: primary.customers.slice(0, 3).map((c) => c.name),
    customerPos: primary.quotes.map((q) => q.customerPo),
  };
  const practice = buildCompany({ kind: "practice", name: `Synthetic Practice PQ ${runId}`, slug: `t-${runId}-practice`, runId, rng: root.fork("practice"), cal, scale: 1, reuse });
  const dataset = {
    meta: { generator: GENERATOR_VERSION, seed, scale, baseDate, runId, marker: { slugPrefix: `t-${runId}-`, emailSuffix: `.${runId}@${EMAIL_DOMAIN}` } },
    companies: [primary, practice],
  };
  dataset.expected = summarise(dataset);
  return dataset;
}

/** Counts and money the loaded database must reproduce (used by the verify step and the tests). */
export function summarise(dataset) {
  const out = {};
  for (const c of dataset.companies) {
    const issued = c.invoices.filter((i) => i.issue);
    out[c.kind] = {
      users: c.users.length,
      customers: c.customers.length,
      parts: c.parts.length,
      machines: c.machines.length,
      quotes: c.quotes.length,
      quotesByStatus: countBy(c.quotes, (q) => q.status),
      jobs: c.jobs.length,
      bookings: c.bookings.length,
      deliveryNotes: c.deliveryNotes.length,
      invoices: c.invoices.length,
      invoicesIssued: issued.length,
      invoicesDraft: c.invoices.length - issued.length,
      creditNotes: c.invoices.filter((i) => i.credit).length,
      payments: c.invoices.reduce((s, i) => s + i.payments.length, 0),
      attendanceEvents: c.attendance.reduce((s, a) => s + a.events.length, 0),
      labourSessions: c.labour.length,
      invoicedTotalPence: issued.reduce((s, i) => s + i.totalPence, 0),
      paidPence: issued.reduce((s, i) => s + i.paidPence, 0),
      creditedPence: issued.reduce((s, i) => s + i.creditedPence, 0),
      outstandingPence: issued.reduce((s, i) => s + i.outstandingPence, 0),
      overdueInvoices: issued.filter((i) => i.overdue).length,
      overduePence: issued.filter((i) => i.overdue).reduce((s, i) => s + i.outstandingPence, 0),
    };
  }
  return out;
}
function countBy(list, fn) {
  const out = {};
  for (const item of list) out[fn(item)] = (out[fn(item)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}
