import { useEffect } from 'react';

/** How fast to scroll (px per animation frame) given the cursor's Y position, viewport height,
 * edge hot-zone size, and top scroll speed — 0 outside the hot zones, easing up to `maxSpeed`
 * right at the very edge of the viewport. Pulled out as a standalone function so it's testable
 * without spinning up a real drag/rAF loop: pointerY near 0 -> full negative (scroll up), pointerY
 * near vh -> full positive (scroll down), pointerY in the middle -> 0 (no scroll). */
export function computeScrollDelta(pointerY, vh, edge, maxSpeed) {
  if (pointerY < edge) return -maxSpeed * (1 - pointerY / edge);
  if (pointerY > vh - edge) return maxSpeed * (1 - (vh - pointerY) / edge);
  return 0;
}

/**
 * Auto-scrolls the page vertically, and optionally one element horizontally, while a native HTML5
 * drag (job chip → truck row/day cell) is active and the cursor is near an edge.
 *
 * VERTICAL — this board has no dedicated scrollable container for the truck rows — `.board-wrap`
 * only scrolls horizontally now (see styles.css); vertical scrolling is the plain page/window
 * scroll (see the research behind this fix: no element in the ancestor chain sets `overflow-y`).
 * Chrome/Firefox both have *some* native "auto-scroll the window near the drag cursor" behavior,
 * but it's unreliable here specifically at the TOP edge: `header` and `nav` are `position: sticky`
 * and sit at z-index 49/50, permanently covering the top ~90px of the viewport — exactly where the
 * browser's native top-edge auto-scroll hot zone would be. Dragging down worked (nothing sits at
 * the bottom of the viewport blocking it); dragging up didn't, because the cursor is moving over
 * the sticky header/nav rather than "bare" scrollable page content.
 *
 * HORIZONTAL (`horizontalScrollRef`, optional) — the day view's timeline now opens scrolled to
 * DEFAULT_VISIBLE_START_HOUR (5am) rather than showing the full 24 hours at once (see DayBoard.jsx
 * and styles.css's `.timeline`/`.timeline-inner`), so a job can easily need to be dropped at an
 * hour that's currently scrolled out of view — e.g. dragging something to an early-morning slot
 * while looking at the 5am-7pm default window. Native drag-auto-scroll doesn't reach into a nested
 * `overflow-x` container like `.timeline` at all (it only ever scrolls the window), so without this
 * there'd be no way to reach an off-screen hour mid-drag short of letting go, scrolling by hand,
 * and starting the drag over. Pass a ref to the scrollable element (`.timeline`) and this scrolls
 * it left/right using the same edge-detection approach as the vertical case, but measured against
 * that element's own bounding box rather than the viewport — and only while the cursor is actually
 * within the element's vertical span, so dragging near the page's left/right edge somewhere else
 * (the timeline can be scrolled out of view vertically) doesn't trigger it by accident.
 *
 * Both directions work the same way underneath: `dragover` events bubble to `window` regardless of
 * what element is under the cursor (including the sticky header/nav, and regardless of whether that
 * element calls preventDefault), so this reads the cursor position directly off those bubbled
 * events and drives its own `scrollBy` loop — symmetric in both directions, unaffected by what's
 * rendered on top of the drag target.
 *
 * `edge` is how close (in px) to an edge triggers scrolling; `maxSpeed` is the fastest scroll rate
 * (px per animation frame), reached right at the very edge and easing to 0 at the edge of the hot
 * zone. Both apply to vertical and horizontal scrolling alike.
 */
export function useDragAutoScroll({ edge = 90, maxSpeed = 20, horizontalScrollRef } = {}) {
  useEffect(() => {
    let pointerX = null;
    let pointerY = null;
    let rafId = null;

    function tick() {
      if (pointerY != null) {
        const verticalDelta = computeScrollDelta(pointerY, window.innerHeight, edge, maxSpeed);
        if (verticalDelta) window.scrollBy(0, verticalDelta);

        const el = horizontalScrollRef?.current;
        if (el && pointerX != null) {
          const rect = el.getBoundingClientRect();
          if (pointerY >= rect.top && pointerY <= rect.bottom) {
            const horizontalDelta = computeScrollDelta(pointerX - rect.left, rect.width, edge, maxSpeed);
            if (horizontalDelta) el.scrollBy(horizontalDelta, 0);
          }
        }
      }
      rafId = requestAnimationFrame(tick);
    }

    function handleDragOver(e) {
      pointerX = e.clientX;
      pointerY = e.clientY;
    }
    // Both fire on drag end regardless of whether the drop succeeded, landed on a valid target, or
    // was cancelled (e.g. Escape) — any of them should stop the scroll.
    function stopScrolling() {
      pointerX = null;
      pointerY = null;
    }

    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('drop', stopScrolling);
    window.addEventListener('dragend', stopScrolling);
    rafId = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('drop', stopScrolling);
      window.removeEventListener('dragend', stopScrolling);
      cancelAnimationFrame(rafId);
    };
  }, [edge, maxSpeed, horizontalScrollRef]);
}
