/*
 * BOUNDARY (module 7, shared UI, NEW). Inputs: none. Output: the public surface of components/ui/premium; other modules import from here only
 * ("@/components/ui/premium") and never reach into the files. Must not change: names exported here once a module depends on them.
 */
export { Button, OnDarkContext, type ButtonProps, type ButtonSize, type ButtonVariant } from "./Button";
export { Switch, Checkbox, type SwitchProps, type CheckboxProps } from "./Switch";
export { FilterChip, ChipGroup, type FilterChipProps } from "./FilterChip";
export { StatusBadge, type StatusTone } from "./StatusBadge";
export { Menu, Popover, nextMenuIndex, type MenuItem } from "./Menu";
export { placeLayer, type LayerPosition } from "./useAnchoredLayer";
export { Dialog, type DialogProps } from "./Dialog";
export { ToastProvider, useToast, TOAST_MS, type ToastInput } from "./Toast";
export { SelectionBar, type SelectionBarProps } from "./SelectionBar";
export { ScrollTable, scrollEdges, type ScrollEdges } from "./ScrollTable";
export { EmptyState, LoadingState, FailedState } from "./StatePanels";
export { premiumTokens, tabularNumbers, srOnly, TOKEN_NAMES, cx } from "./tokens";
