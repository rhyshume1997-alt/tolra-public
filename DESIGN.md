---
name: Tolra
description: Quotes, jobs and invoices for engineering workshops.
colors:
  brand-navy: "#1e3472"
  brand-navy-pressed: "#1a2d62"
  brand-accent: "#2e52b8"
  app-chrome: "#0b1626"
  ink: "#0e1726"
  muted-ink: "#5b6576"
  canvas: "#f5f6f8"
  surface: "#ffffff"
  line: "#e3e6ec"
  input-stroke: "#d5dae2"
  destructive: "oklch(0.577 0.245 27.325)"
  status-green: "#16a34a"
  status-green-text: "#15803d"
  status-yellow: "#ca8a04"
  status-red: "#dc2626"
  status-blue: "#2563eb"
  status-purple: "#7c3aed"
  status-grey: "#6b7280"
  pause-amber: "#f59e0b"
  pause-ink: "#1c1917"
typography:
  display:
    fontFamily: "Anton, Archivo, Impact, sans-serif"
    fontSize: "clamp(2.75rem, 7.2vw, 6.75rem)"
    fontWeight: 400
    lineHeight: 0.94
    letterSpacing: "0.005em"
  headline:
    fontFamily: "Archivo, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  numeral:
    fontFamily: "Archivo, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "2rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.025em"
    fontFeature: "tnum"
  title:
    fontFamily: "Archivo, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "0.95rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Archivo, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  label:
    fontFamily: "IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: 1.45
    letterSpacing: "0.12em"
  label-strong:
    fontFamily: "IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.6875rem"
    fontWeight: 700
    lineHeight: 1.45
    letterSpacing: "0.12em"
  button:
    fontFamily: "IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.7rem"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "0.08em"
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  2xl: "18px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "20px"
  xl: "24px"
  2xl: "40px"
components:
  button-primary:
    backgroundColor: "{colors.brand-navy}"
    textColor: "{colors.surface}"
    typography: "{typography.button}"
    rounded: "{rounded.full}"
    height: "36px"
    padding: "0 16px"
  button-primary-hover:
    backgroundColor: "{colors.brand-navy-pressed}"
  button-outline:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.full}"
    height: "36px"
    padding: "0 16px"
  button-outline-hover:
    backgroundColor: "{colors.canvas}"
  button-start:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.status-green-text}"
    typography: "{typography.button}"
    rounded: "{rounded.full}"
    height: "64px"
  button-finish:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.status-blue}"
    typography: "{typography.button}"
    rounded: "{rounded.full}"
    height: "64px"
  button-pause:
    backgroundColor: "{colors.pause-amber}"
    textColor: "{colors.pause-ink}"
    typography: "{typography.button}"
    rounded: "{rounded.full}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    height: "40px"
    padding: "4px 12px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "20px 0"
  stat-tile:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.numeral}"
    rounded: "{rounded.xl}"
    padding: "20px"
  status-badge:
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    height: "20px"
    padding: "2px 8px"
  nav-item:
    textColor: "{colors.surface}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    height: "40px"
    padding: "8px 12px"
---

# Design System: Tolra

## Overview

**Creative North Star: "The Job Traveller"**

A job traveller is the sheet that goes round the shop with a part. It's labelled, stamped and signed at every station, and it stays plain, so nobody misreads it at a machine. Tolra is built the same way. Every value has a printed caption above it: small uppercase IBM Plex Mono at 0.6875rem with wide tracking. Records sit on white cards ruled with hairlines. Every status carries both a colour and its word. Nothing on screen is ornament. Captions, ruling, status stamps and numbers do all the work.

The mood is **industrial and confident**. The labels and buttons are set in mono like stamped part numbers. Headings are Archivo Semibold set tight. The navy sidebar is as solid as a machine guard. Controls are **tactile and sturdy**: pill buttons with a physical one-pixel press, inputs 40px high, and everything grows to at least 44px on a touch screen. The workshop's Start and Finish buttons are 64px high so they can be hit with gloves on. The office desk gets density. The shop floor gets reach.

The navy is a placeholder. Each company's own colours replace `brand-navy` and `brand-accent` at runtime, before first paint. The system has to look right in a company's red, green or orange as much as in Tolra's navy. That's why structure comes from neutrals, ruling and type rather than from the brand hue.

**Key Characteristics:**
- Mono uppercase captions over every value, like a printed form.
- Flat white cards separated by 1px hairlines, not shadows.
- A saturated brand sidebar. Everything else is neutral, from ink and canvas to white.
- One status colour map. Every badge shows its word next to its colour.
- Pill-shaped mono buttons that press down 1px.
- Touch targets grow to 44px on coarse pointers, 64px for Start and Finish.
- Tabular figures for every number that gets compared.

## Colors

Neutral steel-greys and white carry the structure. One brand colour, owned by each company, takes the sidebar and the primary action, and six fixed status colours mark job, money and sync state.

### Primary
- **Workshop Navy** (#1e3472): Tolra's default brand. It fills the sidebar, the primary button and the default badge. At runtime it is replaced by the company's own primary through `--brand`. Its hover is **Pressed Navy** (#1a2d62), mixed live as 86% brand plus black, so a company's colour gets the same darker step.
- **Signal Blue** (#2e52b8): the brand accent. It marks the focus ring (35% on buttons, 15% on inputs), the active nav bar, active stat tiles, links and the user avatar. It is replaced by the company's accent through `--brand-accent`.
- **Text on brand**: white, or near-black, whichever reads better on the company's colour (`--brand-ink`, computed per company).

### Neutral
- **Machine Ink** (#0e1726): body text, values, outline button text and headings. A blue-black, not pure black.
- **Gauge Grey** (#5b6576): secondary text, card descriptions and placeholders.
- **Shop Canvas** (#f5f6f8): the page background behind cards, the outline button hover and the frosted topbar (85% with a blur).
- **Sheet White** (#ffffff): cards, tiles, dialogs, inputs and sticky table columns.
- **Hairline** (#e3e6ec): every border and divider. It is the default border colour on all elements.
- **Input Stroke** (#d5dae2): the slightly darker border on text fields, so fields read as fillable against hairline-ruled cards.
- **Night Chrome** (#0b1626): the installed app's title bar and icon background only.

### Status
One map (`lib/status-colours.ts`) supplies every status colour. Badges are filled pills that always show their word.
- **Pass Green** (#16a34a): complete, accepted, passed, paid, on time, delivered. Badge text is dark. As text on white it moves one step darker, to **Start Green** (#15803d), to reach 4.5:1.
- **Caution Yellow** (#ca8a04): at risk, waiting for inspection, part paid, waiting on supplier or customer. Always a yellow fill with dark text, never yellow text on a light page.
- **Fault Red** (#dc2626): overdue, blocked supplier, sync failed, failed inspection. It also fills the sidebar's count badge.
- **Running Blue** (#2563eb): active, running, sent, issued, sync pending. It is also the Finish button.
- **Rework Purple** (#7c3aed): rework only. It's a tag shown next to a status, never a status itself.
- **Idle Grey** (#6b7280): draft, not started, archived, void, cancelled.
- **Pause Amber** (#f59e0b) with **Pause Ink** (#1c1917): the solid Pause button. It's kept apart from Start's green and the orange of Inspected.
- **Destructive** (oklch(0.577 0.245 27.325)): destructive buttons use it as a 10% tint with red text, never a solid red block.

### Named Rules
**The Company's Colour Rule.** `brand-navy` and `brand-accent` are slots, not the identity. Never hard-code #1e3472 or #2e52b8 in a component. Use `bg-brand`, `text-brand-ink`, `ring-brand-accent` and so on. Every surface must still read correctly when a company's colour replaces the navy.

**The Stamped Status Rule.** Colour is never the only signal. Every status shows its word, and every status colour comes from the one map. If a new state needs a colour, it goes into `lib/status-colours.ts` first.

**The One Purple Rule.** Purple means rework and nothing else.

## Typography

**Body / Heading Font:** Archivo (with system-ui, -apple-system, Segoe UI)
**Label / Mono Font:** IBM Plex Mono (with ui-monospace, SFMono-Regular, Menlo)
**Display Font:** Anton (with Archivo, Impact). Used only on the dark, website-style sign-in page.

All three are self-hosted through Fontsource, because the content security policy allows only same-origin fonts.

**Character:** Archivo is a grotesque with engineering roots: sturdy, slightly wide and unfussy. Plex Mono adds the stamped, part-number voice to every caption and button. Text is set in light, regular and semibold. There are no heavy black weights.

### Hierarchy
- **Display** (Anton 400, clamp(2.75rem, 7.2vw, 6.75rem), line-height 0.94, uppercase): the headline on a company's dark sign-in page. Nowhere inside the app.
- **Headline** (Archivo 600, 1.875rem, line-height 2.25rem, −0.02em): the page title block (`.page-title`). h1 to h3 all tighten to −0.015em.
- **Numeral** (Archivo 600, 2rem, line-height 1, tight tracking, tabular figures): the headline figure in a stat tile.
- **Title** (Archivo 600, 0.95rem, tight): the company name in the sidebar, and card and record titles.
- **Body** (Archivo 400, 0.875rem): table cells, card text and descriptions. Inputs use 1rem below 768px, so iOS doesn't zoom in, and 0.875rem from 768px up. List view shrinks to 0.8125rem.
- **Label** (Plex Mono 500, 0.6875rem, 0.12em, uppercase): eyebrows, the topbar page name, sidebar section names and table headers (`.label-mono`).
- **Label Strong** (Plex Mono 700, 0.6875rem, 0.12em, uppercase, full ink): captions over a value (`.field-label`) and every Job Board heading. Inside a stacked card it gets its own small box on a muted fill (`.field-caption`).
- **Button** (Plex Mono 500, 0.7rem, 0.08em, uppercase): every button except link buttons. Small sizes drop to 0.66rem, and extra-small to 0.62rem.

### Named Rules
**The Caption-First Rule.** A value is never left unlabelled. When a table header disappears, because the row has stacked into a card on a phone or a tablet, each cell prints its own caption from `data-label`. Captions are in Label Strong, so the eye finds the name before the value.

**The Tabular Rule.** Any figure that will be compared with another (totals, counts, hours, money) uses tabular numerals.

## Layout

The app is a fixed brand sidebar plus a content column capped at 1400px and centred. Page gutters grow with the screen: 16px on phones, 24px from 768px and 40px from the 1025px "desk" breakpoint. Vertical padding goes 24 → 32 → 40px. The 64px topbar is sticky and frosted (canvas at 85% with a medium backdrop blur), and it carries the page name as a mono label.

There are three widths:
- **Desk (1025px and up):** the fixed sidebar and full dense tables. Wide tables scroll sideways inside their own container, while the select box and the record number stay pinned on the left.
- **Tablet (768–1024px):** the sidebar becomes a 280px drawer. Table views show as a grid of cards, at least 17rem wide with 12px gaps, each card 12px-padded and 12px-rounded.
- **Phone (below 768px):** rows stack into blocks, each cell labelled with its own caption.

List pages offer a view switcher: **Table** (every column), **List** (compact rows, secondary columns hidden, zebra rows at 4% ink, 0.8125rem text) and **Cards**. Action cells never truncate. Their buttons wrap onto another line rather than scroll off the side.

Spacing runs on a 4px base. Card padding is 20px, gaps inside a card are 12–16px, and tile grids use 12px gutters.

**The Glove Rule.** On a coarse pointer every control is at least 44px (`pointer-coarse:h-11`), and Start and Finish are at least 64px. Desk sizes (36px buttons, 40px inputs) apply to mouse users only.

## Elevation & Depth

Tolra is flat and ruled. Surfaces are told apart by tone (canvas behind, white in front) and 1px hairlines, not shadows. Cards explicitly remove any shadow. Elevation appears only on things that float above the page and must cover it: dialogs, menus, sheets and toasts. The frosted topbar is the one translucent layer.

### Shadow Vocabulary
- **Dialog lift** (`box-shadow: 0 24px 60px -20px rgba(11, 22, 38, 0.35)`): modal dialogs. A deep, navy-tinted drop that pulls the dialog off the page.
- **Menu lift** (Tailwind `shadow-md`, with a 1px ring at 10% foreground): dropdown menus.
- **Sheet lift** (Tailwind `shadow-lg`): the navigation drawer and side sheets.

### Named Rules
**The Ruled-Not-Raised Rule.** Anything that sits on the page (cards, tiles, tables, panels) is flat, with a hairline border and no shadow. Shadows are only for layers that float over the page.

## Shapes

The shapes are softened but sturdy. The base radius is 10px (`--radius: 0.625rem`), and everything scales from it: 6px for small chips and field captions, 8px for menu items, 10px for inputs, nav items and the sidebar logo plate, 14px for cards and stat tiles, and 18px for dialogs. Buttons and badges are full pills, which keeps the stamped mono labels reading as tags and the controls as things to press. Borders are always 1px. Icons are Lucide at 16–18px with a 1.75 stroke in navigation.

## Components

### Buttons
Stamped, pill-shaped and pressable.
- **Shape:** full pill (9999px), with a 1px border even when it's transparent, so every variant is the same size.
- **Primary:** brand fill with brand-ink text, mono uppercase at 0.7rem and 0.08em tracking. 36px high with 16px side padding; 44px and 20px on touch screens.
- **Hover / Focus / Press:** the fill darkens to the pressed brand colour. Focus shows a 3px ring of the accent at 35%. Pressing moves the button down 1px (`translate-y-px`), the system's one physical cue. Disabled buttons drop to 50% opacity.
- **Outline:** white with a hairline border and ink text. Hover darkens the border to 25% ink and fills with canvas.
- **Secondary / Ghost:** a 5% (or transparent) ink tint that deepens to 9% or 6% on hover.
- **Destructive:** a 10% red tint with red text, deepening to 20% on hover.
- **Job actions:** **Start** is a green outline (#16a34a border, #15803d text). **Finish** is a blue outline. **Pause** is solid amber with dark ink text. On the Job Board's touch layout they are at least 64px high.
- **Link:** the only button in sans and sentence case, in accent blue with an underline on hover.

### Status Badges
- **Style:** a filled pill 20px high with 8px padding, set in mono uppercase at 0.62rem and 0.08em tracking. Fill colours come from the status map. Text is dark on green and yellow, white on red, blue, purple and grey.
- **Rule:** the word is always shown. A job may carry two badges (Overdue plus Rework), and neither hides the other.

### Cards / Containers
- **Corner Style:** 14px.
- **Background:** Sheet White on the Shop Canvas page.
- **Shadow Strategy:** none (see Ruled-Not-Raised).
- **Border:** a 1px hairline.
- **Internal Padding:** 20px top and bottom, 16px sides in the header. The small size uses 12px.

### Stat Tiles
A calm headline number. The mono label starts with a 6px coloured dot for the tone (good, warn, bad, info, rework, neutral). The figure sits 16px below in the 2rem numeral style, with one line of grey context under it. The colour lives in the dot, never as a tinted tile. A clickable tile darkens its border to 20% ink on hover. An active (filtering) tile takes a half-strength accent border and a 1px accent ring. On the Job Board the label row is fixed at two lines, so the figures line up across tiles.

### Inputs / Fields
- **Style:** white, a 1px Input Stroke border, 10px radius, 40px high (44px on touch) and 12px side padding.
- **Focus:** the border turns to the accent, with a soft 3px accent ring at 15%.
- **Error / Disabled:** invalid fields take a red border and a 20% red ring. Disabled fields fade to 50% on a light input-grey fill.

### Navigation
The sidebar is the brand's one solid colour field. It fills with the company colour and holds the company logo on a white 48px plate with 14px corners, or the company's initials. Under the name, the product appears as a faded mono credit. Section names are mono labels at 45% brand-ink. Items are 40px rows (44px on touch) with an 18px icon and 0.9rem text at 70% brand-ink. Hover adds a 7% brand-ink tint. The active item gets an 11% tint, medium weight and a 3px accent bar on its left edge. A red pill on the right shows counts. Below 1025px the sidebar becomes a left drawer opened from the topbar's menu button.

### Signature Component: The Field Caption
This is the traveller's printed label. It's a small box sized to its text, with a 1px border at 45% muted ink, a 6px radius and a muted fill, holding the field name in Plex Mono Bold uppercase at 0.6875rem. It sits above the value on job cards and on every stacked table row. Wherever data loses its column header, it gets this caption instead.

## Do's and Don'ts

### Do:
- **Do** put a mono uppercase caption (Label or Label Strong, 0.6875rem, 0.12em tracking) over every value, and a `data-label` on every table cell that may stack.
- **Do** use the brand tokens (`bg-brand`, `text-brand-ink`, `bg-brand-hover`, `ring-brand-accent`) for anything in the company colour, so each company's colours apply.
- **Do** take every status colour and word from `lib/status-colours.ts` through `StatusBadge`.
- **Do** separate surfaces with 1px Hairline (#e3e6ec) borders and the canvas-to-white step.
- **Do** size every control to at least 44px on coarse pointers, and Start and Finish to 64px.
- **Do** use tabular figures for counts, money and hours.
- **Do** keep stat tiles' colour in the 6px dot and leave the tile white.

### Don't:
- **Don't** hard-code the Tolra navy or accent hex values in components. They are defaults that each company replaces.
- **Don't** add shadows to cards, tiles, tables or panels. Shadows are for dialogs, menus and sheets only.
- **Don't** show a status by colour alone, put yellow text on a light background, or use purple for anything but rework.
- **Don't** use solid red blocks for destructive actions. Use the 10% red tint with red text.
- **Don't** use Anton inside the app. It belongs to the dark sign-in page only.
- **Don't** reach for raw Tailwind `slate-*` greys in new work. Use `ink`, `muted-foreground`, `canvas` and `line`. Older screens still use slate directly.
- **Don't** let action buttons truncate or scroll off the side of a table. They wrap.
