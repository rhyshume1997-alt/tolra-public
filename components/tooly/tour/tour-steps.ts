/**
 * BOUNDARY (Tooly, first-login admin tour): the 23 mandatory scripted steps, as data. Fixed words, no AI, no quiz, no answers.
 * Inputs: none (static). Outputs: ADMIN_TOUR_STEPS, read by tour-plan.ts and admin-tour.tsx.
 * The tour only POINTS. It never clicks, saves, sends, accepts or changes anything, and it never opens a dialog.
 * `target` finds an element already on the page; if it is not there the step is shown centred (nothing is clicked to make it appear).
 * `destination` is the page that must open for this person (role, per-person page access, company menu); if it does not, the step shows
 * `closedText` instead, or is skipped when there is none.
 * Must not change: the step count (23) or order without Rhys, the "points, never clicks" rule, or add em dashes to the words.
 */
export type TourTarget =
  | { kind: "css"; selector: string; phoneSelector?: string }
  | { kind: "text"; tag: "button" | "a" | "h1"; text: string }
  | { kind: "none" };

export type TourStep = {
  n: number;
  id: string;
  /** What Tooly says, plain words. */
  text: string;
  /** The page to be on for this step (the tour moves there; that is navigation, not a click on the app). */
  route: string;
  target: TourTarget;
  /** All 23 are mandatory. Optional steps come after the freeze. */
  mandatory: true;
  /** Page that must open for this person for the step to apply (lib/destinations canOpenDestination). Absent: always applies. */
  destination?: string;
  /** Said instead when `destination` does not open. Absent: the step is skipped. */
  closedText?: string;
};

const css = (selector: string, phoneSelector?: string): TourTarget => ({ kind: "css", selector, phoneSelector });
const button = (text: string): TourTarget => ({ kind: "text", tag: "button", text });
const heading = (text: string): TourTarget => ({ kind: "text", tag: "h1", text });
const NONE: TourTarget = { kind: "none" };

export const ADMIN_TOUR_STEPS: readonly TourStep[] = [
  { n: 1, id: "hello", route: "/dashboard", target: css('[data-testid="tooly-float"]'), mandatory: true,
    text: "Hi, I am Tooly. I will show you around the app in about ten minutes. I only point at things. I never click anything or change anything for you." },
  { n: 2, id: "sign-in", route: "/dashboard", target: heading("Dashboard"), mandatory: true,
    text: "This is the first screen after you sign in. You sign in with your own email and password, and only you should know the password. Admins also type a six digit code from an authenticator app on their phone." },
  { n: 3, id: "dashboard", route: "/dashboard", target: css('[data-testid="overview-jump"]'), mandatory: true,
    text: "This is your Dashboard, the home page. It shows what needs you today, then the money, the work, the machines and your team. Tap a name in this bar to jump down to it." },
  { n: 4, id: "attention", route: "/dashboard", target: css('[data-testid="needs-attention"]'), mandatory: true,
    text: "This card lists the things that need you. Look here first each morning." },
  { n: 5, id: "menu", route: "/dashboard", target: css("aside", '[aria-label="Open menu"]'), mandatory: true,
    text: "This is the menu. Every page is in here. On a phone, tap the three lines at the top left to open it." },
  { n: 6, id: "quotes", route: "/quotes", target: css('a[href="/quotes"]'), mandatory: true, destination: "/quotes",
    text: "Quotes. This is where you work out a price for a customer and send it to them.",
    closedText: "Quotes are switched off for you, so I will skip the quotes part." },
  { n: 7, id: "new-quote", route: "/quotes", target: button("New quote"), mandatory: true, destination: "/quotes",
    text: "To start a quote, press New quote. Pick the customer. Add a line for each thing you sell: what it is, how many, and the price. Check the VAT and the total at the bottom. Then press Save Quote. A saved quote is only a draft. Nothing goes to the customer yet." },
  { n: 8, id: "view-quote", route: "/quotes", target: css('[aria-label^="View QUO-"]'), mandatory: true, destination: "/quotes",
    text: "To look at a quote, press the eye on its row. You can download it as a PDF. That only makes a file on your computer. It sends nothing." },
  { n: 9, id: "send-quote", route: "/quotes", target: NONE, mandatory: true, destination: "/quotes",
    text: "To send a quote, open it and press Send to Customer. You will be asked to confirm. Yes, send opens your own email program, and you send it from there. Email it now sends from Tolra if email is set up. If email is not set up, it only saves a draft for you in Approvals. I will not send anything now." },
  { n: 10, id: "decide-quote", route: "/quotes", target: NONE, mandatory: true, destination: "/quotes",
    text: "When the customer says yes, open the quote and press Mark Accepted. Tolra then makes the order and, if your company has it on, the job. When they say no, press Mark Rejected. You cannot undo either one, so check twice." },
  { n: 11, id: "jobs", route: "/jobs", target: heading("Job Board"), mandatory: true, destination: "/jobs",
    text: "Jobs. This is the Job Board. Every job is here. Each job shows a status: Not started, Running, Waiting for inspection, or Complete.",
    closedText: "The Job Board is switched off for you, so I will skip the jobs part." },
  { n: 12, id: "new-job", route: "/jobs", target: button("New job"), mandatory: true, destination: "/jobs",
    text: "To add a job yourself, press New job. Pick the customer, say what the work is, and add the date it is needed. A job moves through Material, Setup, Machining and Inspection." },
  { n: 13, id: "job-buttons", route: "/jobs", target: css('[data-job-id], [data-testid="empty-hint"]'), mandatory: true, destination: "/jobs",
    text: "Each job has buttons. Start begins the work. Finish says the work is done. Inspected records the check. Reopen undoes a finish. Print gives the job sheet. Worksheet opens all the details." },
  { n: 14, id: "job-filters", route: "/jobs", target: NONE, mandatory: true, destination: "/jobs",
    text: "Use the filters above the jobs to find one fast: Show, Due and Stage. Late means the job is past the date it was needed." },
  { n: 15, id: "schedule", route: "/schedule", target: heading("Machine Schedule"), mandatory: true, destination: "/schedule",
    text: "The Machine Schedule shows when each machine is free. Press New booking to put a job on a machine.",
    closedText: "The Machine Schedule is switched off for you, so I will skip it." },
  { n: 16, id: "main-buttons", route: "/dashboard", target: css('[data-testid="global-search-input"]'), mandatory: true,
    text: "Here is what the main buttons do. The big button at the top right of a page makes something new. The eye opens a record. The three lines open the menu. The magnifier searches. The bell shows emails waiting for your OK. Log out ends your day safely." },
  { n: 17, id: "settings", route: "/settings", target: heading("Settings"), mandatory: true, destination: "/settings",
    text: "Settings. Most features are off until you switch them on here. Nothing I show you changes by itself." },
  { n: 18, id: "menu-sections", route: "/settings", target: css('[role="switch"][aria-label="Show Quote Generator"]'), mandatory: true, destination: "/settings",
    text: "Menu Sections. Each switch shows or hides one page in the menu for everyone in your company." },
  { n: 19, id: "quote-to-job", route: "/settings", target: css('[role="switch"][aria-label="Make the job automatically"]'), mandatory: true, destination: "/settings",
    text: "Quote to job. When this is on, accepting a quote makes the job for you. Customer sign-off is a different switch, and it is off until you want it." },
  { n: 20, id: "job-reports", route: "/settings", target: css('[role="switch"][aria-label="Reports page"]'), mandatory: true, destination: "/settings",
    text: "Job reports. Three switches, all off until you turn them on: planned against actual machine time, the NCR register, and the Reports page." },
  { n: 21, id: "company-details", route: "/settings", target: css('[data-testid="company-details-form"]'), mandatory: true, destination: "/settings",
    text: "Also in Settings: your company details, logo and colours, working hours, and email templates. The setup list on this page helps you check each one." },
  { n: 22, id: "people", route: "/admin/users", target: button("New user"), mandatory: true, destination: "/admin/users",
    text: "People live in User Management. Add someone, give them a role, and choose which pages they can see. Integrations is where Xero, Microsoft 365 email and AI are connected. AI stays off until you turn it on." },
  { n: 23, id: "done", route: "/dashboard", target: css('[data-testid="tooly-float"]'), mandatory: true,
    text: "That is the tour. Tap my face any time. You can hide me with the Hide button. Well done." },
];
