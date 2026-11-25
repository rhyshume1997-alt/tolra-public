/*
 * BOUNDARY (module 7, shared UI, NEW). Inputs: none. Output: the public surface of components/ui/premium; other modules import from here only
 * ("@/components/ui/premium") and never reach into the files. Must not change: names exported here once a module depends on them.
 */
export { Button, OnDarkContext, type ButtonProps, type ButtonSize, type ButtonVariant } from "./Button";
export { Switch, Checkbox, dataAttributes, type SwitchProps, type CheckboxProps } from "./Switch";
export { FilterChip, ChipGroup, type FilterChipProps } from "./FilterChip";
export { StatusBadge, toneClassKey, type StatusTone, type StatusMode } from "./StatusBadge";
export { Menu, Popover, nextMenuIndex, pickFirstEnabled, withDangerSeparator, type MenuItem } from "./Menu";
export { placeLayer, layerOriginStyle, type LayerPosition } from "./useAnchoredLayer";
export { Dialog, type DialogProps } from "./Dialog";
export { ToastProvider, useToast, TOAST_MS, toastRegionStyle, type ToastInput, type ToastPlacement } from "./Toast";
export { SelectionBar, selectionControls, type SelectionBarProps, type BarWhen } from "./SelectionBar";
export { ScrollTable, scrollEdges, rowClickIsForRow, pinOffsets, planStack, type ScrollEdges, type StackColumn, type StackOptions, type StackRole } from "./ScrollTable";
export { EmptyState, LoadingState, FailedState, type HeadingLevel } from "./StatePanels";
export { SegmentedControl, nextSegmentIndex, tabStopIndex, type SegmentedControlProps, type SegmentedOption } from "./SegmentedControl";
export { Sheet, type SheetProps } from "./Sheet";
export { Field, Input, Textarea, Select, fieldDescribedBy, type FieldProps, type InputProps, type TextareaProps, type SelectProps } from "./Field";
export { StatTile, StatTiles, type StatTileProps } from "./StatTile";
// v3 (added, none renamed)
export { Panel, Callout, calloutLead, type PanelProps, type PanelVariant, type CalloutProps, type CalloutTone } from "./Surface";
export { Disclosure, attentionSummary, type DisclosureProps, type DisclosureVariant } from "./Disclosure";
export { List, ListRow, type ListRowProps } from "./List";
export { FormGroup, ErrorSummary, DateRangeGroup, focusFirstInvalid, pickInvalidTarget, rangeError, type FormGroupProps, type ErrorSummaryItem, type ErrorSummaryProps, type DateRangeGroupProps } from "./FormParts";
export { premiumTokens, tabularNumbers, srOnly, TOKEN_NAMES, typeScale, cx } from "./tokens";
// v4 (added, none renamed): PageHeader, Tabs, PreviewBar, StackedRows, the presence hooks.
export { PageHeader, type PageHeaderProps } from "./PageHeader";
export { Tabs, TabPanel, isTabKey, fitTabs, type TabsProps, type TabItem } from "./Tabs";
export { PreviewBar, PREVIEW_LABEL, PREVIEW_SHORT_LABEL, type PreviewBarProps } from "./PreviewBar";
export { StackedRows, type StackedRowsProps, type StackedRow, type StackedField } from "./StackedRows";
export { UI_FONT_FAMILY, UI_FONT_WEIGHTS } from "./fonts";
export { usePresence, useEntered, useModalPresence, EXIT_MS } from "./usePresence";
/*
 * v4 default look changes (all visual, no prop, control or behaviour removed): table header cells are 12 px uppercase tracked (were 12.5 px sentence case); body text, hints, labels and meta lines sit on the new type scale
 * (hints and meta 13 px, was 12.5; menu items and state text 14 px, were 13.5; names and titles weight 600, KPI figures 600, field labels 600 at 13 px); button, chip and segment press is scale(0.97) (was a 1 px move); Menu, Popover, Dialog,
 * Sheet and Toast animate by transition with a 120 ms exit (they unmount at once for a keyboard open or close); a StatTile status line is the quiet text mode; the compact EmptyState draws no card of its own; the default pill rim is lighter;
 * shadows use the elevation tokens (a 1 px inner highlight on cards); touch screens no longer show hover styles.
 */
// v5 (added, none renamed): ExpanderButton and Button size "icon", RemovableChip(s), FiltersPopover, the label-in-name helpers; options on SegmentedControl, PreviewBar, SelectionBar, Menu, Dialog, ScrollTable, Disclosure, StatTile.
export { ExpanderButton, type ExpanderButtonProps } from "./Expander";
export { RemovableChip, RemovableChips, type RemovableChipProps } from "./RemovableChip";
export { FiltersPopover, filtersLabel, type FiltersPopoverProps, type FilterGroup, type FilterChoice, type ActiveFilter } from "./FiltersPopover";
export { nameWithVisible, nameContainsVisible } from "./accessibleName";
export { revealInRow, revealOffset } from "./revealInRow";
/*
 * v5 default look changes (everything else is opt in): every SegmentedControl segment is at least 48 px wide (short labels such as "All" and "List" were 33 to 43 px) and, under 640 px, the control is one row that scrolls inside itself instead of wrapping (no lone "All" on a second row);
 * under 640 px the PreviewBar label wraps to a second line instead of being cut with an ellipsis (the strip grows from 28 to about 40 px there); under 640 px an ACTIVE SelectionBar is one row of 48 px with its actions scrolling inside it (it wrapped to 120 to 190 px);
 * a Dialog description keeps its line breaks. Nothing else changes unless a new prop is passed.
 */
/*
 * v6 NO SIDEWAYS SCROLLING (the owner's hard rule: nothing scrolls or overflows sideways on a phone or tablet, 1024 px and under). Added (none renamed): ScrollTable props primary, columnPriority, actionsColumn, stackHide (and planStack, StackOptions); SegmentedControl collapseToSelect; Tabs overflow="more" (and fitTabs, moreLabel).
 * v6 default look changes: (1) ScrollTable at 1024 px and under is STACKED RECORDS, not a scroll box (title line, label/value pairs from the header text, actions row at the bottom, totals as a block, header row hidden visually, pinFirst and pinLast ignored; above 1024 px unchanged);
 * (2) SegmentedControl no longer scrolls inside itself under 640 px: its track fills the width and the segments share and wrap onto rows; (3) an active SelectionBar under 640 px wraps (count line, then actions) instead of scrolling its actions (use compact for one row);
 * (4) buttons, chips, segments, badges and tabs wrap a too-long label inside themselves at 1024 px and under (they grow taller, never wider than the screen); (5) menu, popover, dialog, sheet and toast are never wider than the viewport minus 16 px and scroll vertically only;
 * (6) long unbroken words and numbers wrap in field text, tiles, panels, callouts, disclosures, state panels and dialogs; Tabs rows are 4 px apart when they wrap. The stylesheet is checked by tests/unit/uiPremium.test.ts: a horizontal scroll rule is allowed only inside @media (min-width: 1025px).
 */
