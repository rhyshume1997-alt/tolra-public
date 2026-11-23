/*
 * BOUNDARY (module 7, shared UI, NEW). Inputs: none. Output: the public surface of components/ui/premium; other modules import from here only
 * ("@/components/ui/premium") and never reach into the files. Must not change: names exported here once a module depends on them.
 */
export { Button, OnDarkContext, type ButtonProps, type ButtonSize, type ButtonVariant } from "./Button";
export { Switch, Checkbox, dataAttributes, type SwitchProps, type CheckboxProps } from "./Switch";
export { FilterChip, ChipGroup, type FilterChipProps } from "./FilterChip";
export { StatusBadge, toneClassKey, type StatusTone, type StatusMode } from "./StatusBadge";
export { Menu, Popover, nextMenuIndex, pickFirstEnabled, type MenuItem } from "./Menu";
export { placeLayer, layerOriginStyle, type LayerPosition } from "./useAnchoredLayer";
export { Dialog, type DialogProps } from "./Dialog";
export { ToastProvider, useToast, TOAST_MS, toastRegionStyle, type ToastInput, type ToastPlacement } from "./Toast";
export { SelectionBar, selectionControls, type SelectionBarProps, type BarWhen } from "./SelectionBar";
export { ScrollTable, scrollEdges, rowClickIsForRow, type ScrollEdges } from "./ScrollTable";
export { EmptyState, LoadingState, FailedState, type HeadingLevel } from "./StatePanels";
export { SegmentedControl, nextSegmentIndex, tabStopIndex, type SegmentedControlProps, type SegmentedOption } from "./SegmentedControl";
export { Sheet, type SheetProps } from "./Sheet";
export { Field, Input, Textarea, Select, fieldDescribedBy, type FieldProps, type InputProps, type TextareaProps, type SelectProps } from "./Field";
export { StatTile, StatTiles, type StatTileProps } from "./StatTile";
// v3 (added, none renamed)
export { Panel, Callout, calloutLead, type PanelProps, type PanelVariant, type CalloutProps, type CalloutTone } from "./Surface";
export { Disclosure, type DisclosureProps } from "./Disclosure";
export { List, ListRow, type ListRowProps } from "./List";
export { FormGroup, ErrorSummary, DateRangeGroup, focusFirstInvalid, pickInvalidTarget, rangeError, type FormGroupProps, type ErrorSummaryItem, type ErrorSummaryProps, type DateRangeGroupProps } from "./FormParts";
export { premiumTokens, tabularNumbers, srOnly, TOKEN_NAMES, typeScale, cx } from "./tokens";
// v4 (added, none renamed): PageHeader, Tabs, PreviewBar, StackedRows, the presence hooks.
export { PageHeader, type PageHeaderProps } from "./PageHeader";
export { Tabs, TabPanel, isTabKey, type TabsProps, type TabItem } from "./Tabs";
export { PreviewBar, PREVIEW_LABEL, type PreviewBarProps } from "./PreviewBar";
export { StackedRows, type StackedRowsProps, type StackedRow, type StackedField } from "./StackedRows";
export { usePresence, useEntered, useModalPresence, EXIT_MS } from "./usePresence";
/*
 * v4 default look changes (all visual, no prop, control or behaviour removed): table header cells are 12 px uppercase tracked (were 12.5 px sentence case); body text, hints, labels and meta lines sit on the new type scale
 * (hints and meta 13 px, was 12.5; menu items and state text 14 px, were 13.5; names and titles weight 600, KPI figures 600, field labels 600 at 13 px); button, chip and segment press is scale(0.97) (was a 1 px move); Menu, Popover, Dialog,
 * Sheet and Toast animate by transition with a 120 ms exit (they unmount at once for a keyboard open or close); a StatTile status line is the quiet text mode; the compact EmptyState draws no card of its own; the default pill rim is lighter;
 * shadows use the elevation tokens (a 1 px inner highlight on cards); touch screens no longer show hover styles.
 */
