import * as React from "react"

/**
 * KEEP WHAT THE USER IS LOOKING AT UNDER THE SAME PIXEL.
 *
 * THE PROBLEM THIS EXISTS FOR
 * Every editor here centres its working surface in whatever space is left over:
 * the video editor centres a fixed-size player in the middle column, the image
 * editor draws the artboard at `canvasWidth / 2 + pan`. Centring is right — until
 * the space changes size. Collapse the Assets column and the middle column grows
 * by ~276px on its left, its centre moves ~138px, and the picture the user was
 * looking at JUMPS sideways. Nothing about their work changed; the chrome moved
 * and dragged the work along with it.
 *
 * That is the difference between "I put a panel away" and "where did my shot
 * go" — and it happens on every collapse, every reopen, every drag of a panel
 * edge, and every time the agent chat outside the iframe gives the editor more
 * room.
 *
 * WHAT THIS DOES
 * Watches an element's box and reports how far its CENTRE moved on screen since
 * the last measurement. The caller cancels that movement in whatever units it
 * thinks in — a pan offset, a translate — so the surface stays still and the
 * space that appeared simply becomes more room.
 *
 * This is the rule BlockSuite already applies on the board: its viewport pins
 * the top-left model coordinate across a resize (`Viewport._completeResize`), so
 * a wider canvas reveals more and moves nothing. These editors now agree with
 * it instead of each doing something different.
 *
 * WHAT IT DOES NOT DO
 * It never fires on the first measurement — that one only establishes the
 * baseline, so a surface is free to lay itself out however it likes on mount.
 * And it reports, it does not act: clamping (so a compensated element cannot be
 * pushed out of view) belongs to the caller, which is the only one that knows
 * how much room the thing needs.
 */
export function useCenterShift(
  ref: React.RefObject<HTMLElement | null>,
  onShift: (dx: number, dy: number) => void,
): void {
  // The callback is re-created on every render by most callers; holding it in a
  // ref keeps the observer from being torn down and re-attached each time,
  // which would re-baseline and swallow the very shift we are watching for.
  const latest = React.useRef(onShift)
  latest.current = onShift

  React.useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === "undefined") return

    let prev: { cx: number; cy: number } | null = null

    const measure = () => {
      const r = el.getBoundingClientRect()
      // A hidden element measures 0×0 at the viewport origin. Treating that as
      // a real move would fire a huge bogus shift and then another one on the
      // way back — so skip it and keep the last live baseline.
      if (r.width === 0 && r.height === 0) return
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const before = prev
      prev = { cx, cy }
      if (!before) return
      const dx = cx - before.cx
      const dy = cy - before.cy
      if (dx !== 0 || dy !== 0) latest.current(dx, dy)
    }

    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    // A ResizeObserver fires when the element's own box changes — not when it
    // merely MOVES. The window listener covers the rest: a browser resize can
    // shift a centred element without changing the observed element at all.
    window.addEventListener("resize", measure)
    return () => {
      ro.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [ref])
}
