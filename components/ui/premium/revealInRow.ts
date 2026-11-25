/*
 * BOUNDARY (module 7, shared UI, NEW v5). Inputs: a horizontally scrolling row (the scroller) and one element inside it (the target). Output: scrollLeft of the scroller is changed so the target is FULLY inside the row's visible width (plus a small margin); nothing else moves (the page never scrolls).
 * Used by SegmentedControl and SelectionBar under 640 px, where the row scrolls inside itself: the browser scrolls a focused control into view only when it is wholly hidden, so a half-visible action would stay half-visible for a keyboard user.
 * Must not change: it is pure DOM measurement and one scrollLeft write; it reads no data and has no React.
 */

/** Pure: the scrollLeft that puts [targetLeft, targetRight] fully inside [0, viewWidth] given the current scrollLeft (all in the scroller's own scroll coordinates for the target, margin on both sides). Returns the current value when it is already inside. */
export function revealOffset(scrollLeft: number, viewWidth: number, targetLeft: number, targetRight: number, margin = 6): number {
  if (targetLeft - margin < scrollLeft) return Math.max(0, targetLeft - margin);
  if (targetRight + margin > scrollLeft + viewWidth) return targetRight + margin - viewWidth;
  return scrollLeft;
}

/** Scrolls the scroller sideways, only when it really scrolls, so that the target is fully visible. */
export function revealInRow(scroller: HTMLElement | null | undefined, target: HTMLElement | null | undefined, margin = 6): void {
  if (!scroller || !target || scroller.scrollWidth <= scroller.clientWidth + 1) return;
  const s = scroller.getBoundingClientRect();
  const t = target.getBoundingClientRect();
  const next = revealOffset(scroller.scrollLeft, scroller.clientWidth, t.left - s.left + scroller.scrollLeft, t.right - s.left + scroller.scrollLeft, margin);
  if (next !== scroller.scrollLeft) scroller.scrollLeft = next;
}
