/**
 * YIELD TO THE BROWSER WITHOUT A TIMER — so work keeps going in a hidden tab.
 *
 * Long loops (the export's frame loop, audio chunking) hand the event loop back
 * every few steps so the page stays responsive and memory is reclaimed. They
 * used `await new Promise(r => setTimeout(r, n))` for that. In a BACKGROUND tab
 * Chrome clamps chained timers to about one per second, and after five hidden
 * minutes to about one per MINUTE ("intensive throttling"), so an export that
 * yields every 5 frames crawled to ~5 frames a minute the moment the person
 * switched tabs. A MessageChannel message is a task, not a timer: it is not
 * throttled, so the loop runs at full speed whether or not the tab is visible.
 *
 * Use this for "let the browser breathe" yields. Keep setTimeout only where a
 * real delay (a backoff, a timeout guard) is meant.
 */
export function yieldToEventLoop(): Promise<void> {
  if (typeof MessageChannel === "undefined") {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}
