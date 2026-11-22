/**
 * BOUNDARY (Tooly, scripted tours for office and workshop): the fixed steps for the office view (17) and the workshop view (13), as data.
 * Fixed words, no AI, no quiz, no answers. Same rules as the admin tour in tour-steps.ts: the tour only POINTS, it never clicks, saves,
 * sends, accepts or changes anything, and it never opens a dialog.
 * Inputs: none (static). Outputs: OFFICE_TOUR_STEPS and WORKSHOP_TOUR_STEPS, read by tour-plan.ts.
 * Where an office step says the same thing as an admin step it is that admin step, word for word (reuse below), so the wording Rhys
 * approved for the admin tour is not written twice. Every other step is written here from what the page really shows.
 * `route` and `destination` are pages the role can open (lib/destinations); tour-plan.ts still checks them per person, so a page that
 * is switched off for this person says closedText or is skipped.
 * Must not change: the step counts (17 and 13) or order without Rhys, the "points, never clicks" rule, the plain words (no em or en
 * dashes), or the admin steps (they live in tour-steps.ts and are not edited here).
 */
import { ADMIN_TOUR_STEPS, type TourStep, type TourTarget } from "@/components/tooly/tour/tour-steps";

const css = (selector: string, phoneSelector?: string): TourTarget => ({ kind: "css", selector, phoneSelector });
const heading = (text: string): TourTarget => ({ kind: "text", tag: "h1", text });
const NONE: TourTarget = { kind: "none" };

/** An admin step as it is, renumbered. Throws at load if the id is gone, so the tours cannot drift silently (a test also pins it). */
function reuse(id: string, n: number): TourStep {
  const step = ADMIN_TOUR_STEPS.find((candidate) => candidate.id === id);
  if (!step) throw new Error(`role tours: admin tour step "${id}" no longer exists`);
  return { ...step, n };
}

/** An admin step's page and pointer with words written for this role. */
function reword(id: string, n: number, text: string, closedText?: string): TourStep {
  return { ...reuse(id, n), text, closedText: closedText ?? reuse(id, n).closedText };
}

export const OFFICE_TOUR_STEPS: readonly TourStep[] = [
  { n: 1, id: "hello", route: "/dashboard", target: css('[data-testid="tooly-float"]'), mandatory: true,
    text: "Hi, I am Tooly. I will show you around the pages you use as office staff, in about eight minutes. I only point at things. I never click anything or change anything for you." },
  { n: 2, id: "dashboard", route: "/dashboard", target: heading("Dashboard"), mandatory: true,
    text: "This is the first screen after you sign in. You sign in with your own email and password, and only you should know the password. This is your Dashboard, the home page. It shows what needs you today." },
  reuse("attention", 3),
  reword("menu", 4, "This is the menu. Every page you can use is in here. On a phone, tap the three lines at the top left to open it. A page that is not in your menu is switched off for you. Ask an admin if you need it."),
  reuse("quotes", 5),
  reuse("new-quote", 6),
  reuse("send-quote", 7),
  reuse("decide-quote", 8),
  reuse("jobs", 9),
  reuse("job-buttons", 10),
  { n: 11, id: "delivery-notes", route: "/delivery-notes", target: heading("Delivery Notes"), mandatory: true, destination: "/delivery-notes",
    text: "Delivery Notes. A delivery note goes with finished work. Despatch means sending finished work to the customer.",
    closedText: "Delivery Notes are switched off for you, so I will skip them." },
  { n: 12, id: "invoices", route: "/invoices", target: heading("Invoicing"), mandatory: true, destination: "/invoices",
    text: "Invoicing. Invoices are what customers owe us. You can see what is unpaid and chase it. A draft invoice has no number and is not owed until a person issues it.",
    closedText: "Invoicing is switched off for you, so I will skip it." },
  { n: 13, id: "customers", route: "/customers", target: heading("Customers"), mandatory: true, destination: "/customers",
    text: "Customers are the companies we sell to. They are used on quotes, sales orders and invoices. Suppliers, just below it in the menu, are the companies we buy from. They are used on purchase orders.",
    closedText: "Customers are switched off for you, so I will skip customers and suppliers." },
  { n: 14, id: "purchase-orders", route: "/purchase-orders", target: heading("Purchase Orders"), mandatory: true, destination: "/purchase-orders",
    text: "Purchase Orders. These are what we buy from suppliers.",
    closedText: "Purchase Orders are switched off for you, so I will skip them." },
  { n: 15, id: "approvals", route: "/approval", target: heading("Approval Queue"), mandatory: true, destination: "/approval",
    text: "The Approval Queue is where emails that Tolra has drafted wait for your OK. The bell at the top shows how many are waiting.",
    closedText: "The Approval Queue is switched off for you, so I will skip it." },
  reuse("main-buttons", 16),
  reuse("done", 17),
];

export const WORKSHOP_TOUR_STEPS: readonly TourStep[] = [
  { n: 1, id: "hello", route: "/dashboard", target: css('[data-testid="tooly-float"]'), mandatory: true,
    text: "Hi, I am Tooly. I will show you around the parts of the app you use in the workshop, in about five minutes. I only point at things. I never press anything or change anything for you." },
  { n: 2, id: "dashboard", route: "/dashboard", target: heading("Dashboard"), mandatory: true,
    text: "This is the first screen after you sign in. You sign in with your own email and password. If the tablet is not used for 30 minutes it locks, and you type your password to carry on. Work you did offline is kept and is sent after you sign in again." },
  reword("menu", 3, "This is the menu. The pages you can use are in here. On a phone or a tablet, tap the three lines at the top left to open it. A page that is not in your menu is switched off for you."),
  reuse("jobs", 4),
  { n: 5, id: "job-buttons", route: "/jobs", target: css('[data-job-id], [data-testid="empty-hint"]'), mandatory: true, destination: "/jobs",
    text: "Each job has buttons. Start begins the work. While it runs the same button says Pause, and after a pause it says Resume. Finish says the work is done. Machines shows the machines and hours. Worksheet opens all the details. I will not press any of them." },
  { n: 6, id: "pick-machine", route: "/jobs", target: NONE, mandatory: true, destination: "/jobs",
    text: "Before you press Start, pick the machine in the Machine column, or choose No machine (bench). The Start button says Pick a machine until you have." },
  reuse("job-filters", 7),
  { n: 8, id: "schedule", route: "/schedule", target: heading("Machine Schedule"), mandatory: true, destination: "/schedule",
    text: "The Machine Schedule shows when each machine is free and what is booked on it.",
    closedText: "The Machine Schedule is switched off for you, so I will skip it." },
  { n: 9, id: "delivery-notes", route: "/delivery-notes", target: heading("Delivery Notes"), mandatory: true, destination: "/delivery-notes",
    text: "Delivery Notes. A delivery note goes with finished work. Despatch means sending finished work to the customer.",
    closedText: "Delivery Notes are switched off for you, so I will skip them." },
  { n: 10, id: "hours", route: "/time", target: NONE, mandatory: true, destination: "/time",
    text: "Hours. Here you clock in and out and take breaks. You also see the jobs you worked on and the hours you worked each day and week.",
    closedText: "Hours are switched off for you, so I will skip them." },
  { n: 11, id: "offline", route: "/jobs", target: NONE, mandatory: true, destination: "/jobs",
    text: "If the internet drops, the Job Board still opens from this device and says Offline with the time it last synced. A Start or a worksheet save waits on the device and is sent when the connection is back." },
  { n: 12, id: "main-buttons", route: "/dashboard", target: css('[data-testid="global-search-input"]'), mandatory: true,
    text: "Here is what the main buttons do. The three lines open the menu. The magnifier searches. Log out ends your day safely." },
  reuse("done", 13),
];
