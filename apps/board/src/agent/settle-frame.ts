/** Yield for layout without depending on animation frames in a background tab.
 * Chromium may suspend RAF there indefinitely. The timer is a fallback, not
 * evidence that pixels were painted; capture still validates its own result.
 */
export function settleFrame(): Promise<void> {
  return new Promise(resolve => {
    let frame: number | undefined;
    const finish = () => {
      clearTimeout(timer);
      if (frame !== undefined) cancelAnimationFrame(frame);
      resolve();
    };
    const timer = setTimeout(finish, 100);
    frame = requestAnimationFrame(finish);
  });
}
