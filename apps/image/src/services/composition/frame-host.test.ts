/**
 * jsdom will not run scripts inside an iframe's srcdoc, so these do not prove a
 * real block settles — that was measured in a browser instead. What they pin is
 * the host's half of the protocol, which is where the failures actually were:
 * listening too late, trusting an origin that means nothing, and hanging when a
 * message never arrives.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CompositionHost, fitScale } from './frame-host';

const HTML = '<!DOCTYPE html><html><body>block</body></html>';

function makeHost(over: Partial<ConstructorParameters<typeof CompositionHost>[1]> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const host = new CompositionHost(container, {
    html: HTML,
    frameWidth: 1920,
    frameHeight: 1080,
    readyTimeoutMs: 200,
    pingAfterMs: 50,
    ...over,
  });
  return { host, container };
}

/** Speak as the frame would. jsdom gives every iframe a real contentWindow. */
function settleAs(host: CompositionHost, state: string, detail: unknown = { seeked: 1 }) {
  window.dispatchEvent(new MessageEvent('message', {
    source: host.element!.contentWindow,
    data: { __composition: 'ready', state, detail, atMs: 42 },
  }));
}

afterEach(() => { document.body.innerHTML = ''; });

describe('fitting a frame into a box', () => {
  it('shrinks to whichever axis binds', () => {
    expect(fitScale({ width: 1920, height: 1080 }, { width: 960, height: 1000 })).toBeCloseTo(0.5);
    expect(fitScale({ width: 1920, height: 1080 }, { width: 1920, height: 540 })).toBeCloseTo(0.5);
  });

  it('never enlarges past 1', () => {
    // Scaling a composition up is a blurry composition: the pixels come from a
    // document laid out at frame size.
    expect(fitScale({ width: 100, height: 100 }, { width: 4000, height: 4000 })).toBe(1);
  });

  it('degrades to 1 for a degenerate frame or box', () => {
    expect(fitScale({ width: 0, height: 0 }, { width: 100, height: 100 })).toBe(1);
    expect(fitScale({ width: 100, height: 100 }, { width: 0, height: 0 })).toBe(1);
  });
});

describe('the listener goes on before the document', () => {
  it('catches a frame that settles the instant it is handed the document', async () => {
    // The exact failure this ordering prevents: a frame that has already settled
    // by the time anyone listens, and a mount that then waits for a message
    // which will never come again. Measured in a browser at one second late;
    // here the frame answers synchronously, which is the same race with the
    // timing removed.
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    Object.defineProperty(frame, 'srcdoc', {
      set() {
        window.dispatchEvent(new MessageEvent('message', {
          source: frame.contentWindow,
          data: { __composition: 'ready', state: 'ok', detail: { seeked: 1 }, atMs: 7 },
        }));
      },
      get() { return ''; },
      configurable: true,
    });

    const { host } = makeHost({ createFrame: () => frame, readyTimeoutMs: 60 });
    await expect(host.mount()).resolves.toMatchObject({ status: 'ready', atMs: 7 });
  });
});

describe('which messages count', () => {
  it('accepts a ready from its own frame', async () => {
    const { host } = makeHost();
    const p = host.mount();
    settleAs(host, 'ok');
    await expect(p).resolves.toMatchObject({ status: 'ready', atMs: 42 });
  });

  it('ignores a message from a different frame', async () => {
    // Any window can postMessage, and a deck has one frame per page.
    const { host } = makeHost();
    const other = document.createElement('iframe');
    document.body.appendChild(other);
    const p = host.mount();
    window.dispatchEvent(new MessageEvent('message', {
      source: other.contentWindow,
      data: { __composition: 'ready', state: 'ok' },
    }));
    // Nothing accepted it, so only the timeout resolves this.
    await expect(p).resolves.toMatchObject({ status: 'timeout' });
  });

  it('does not trust origin, because a sandboxed frame reports "null"', async () => {
    // Every sandboxed frame on the page shares that origin, so it distinguishes
    // nothing. Source identity is the only usable check.
    const { host } = makeHost();
    const p = host.mount();
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'null',
      source: host.element!.contentWindow,
      data: { __composition: 'ready', state: 'ok' },
    }));
    await expect(p).resolves.toMatchObject({ status: 'ready' });
  });

  it('keeps waiting through a pending answer', async () => {
    // `pending` says the frame is alive and not settled — an answer, not the one
    // being waited for.
    const { host } = makeHost();
    const p = host.mount();
    settleAs(host, 'pending', null);
    settleAs(host, 'ok');
    await expect(p).resolves.toMatchObject({ status: 'ready' });
  });

  it('ignores unrelated postMessage traffic', async () => {
    const { host } = makeHost();
    const p = host.mount();
    window.dispatchEvent(new MessageEvent('message', {
      source: host.element!.contentWindow,
      data: { hello: 'world' },
    }));
    settleAs(host, 'ok');
    await expect(p).resolves.toMatchObject({ status: 'ready' });
  });
});

describe('recovering and giving up', () => {
  it('pings a frame that has said nothing', async () => {
    const { host } = makeHost({ pingAfterMs: 10 });
    const p = host.mount();
    const post = vi.fn();
    Object.defineProperty(host.element!, 'contentWindow', { value: { postMessage: post }, configurable: true });
    await new Promise((r) => setTimeout(r, 40));
    expect(post).toHaveBeenCalledWith({ __composition: 'ping' }, '*');
    host.destroy();
    await p;
  });

  it('resolves as timeout rather than hanging', async () => {
    // A slow composition is still showable; the caller decides. Only a broken
    // mount is an error.
    const { host } = makeHost({ readyTimeoutMs: 30 });
    await expect(host.mount()).resolves.toMatchObject({ status: 'timeout' });
  });

  it('reports the frame\'s own timeout distinctly from the host giving up', async () => {
    const { host } = makeHost();
    const p = host.mount();
    settleAs(host, 'timeout', null);
    await expect(p).resolves.toMatchObject({ status: 'timeout' });
  });

  it('surfaces an error state from the frame', async () => {
    const { host } = makeHost();
    const p = host.mount();
    settleAs(host, 'error', null);
    await expect(p).resolves.toMatchObject({ status: 'error' });
  });
});

describe('tearing down', () => {
  it('settles a pending mount instead of leaving it hanging', async () => {
    const { host } = makeHost({ readyTimeoutMs: 10_000 });
    const p = host.mount();
    host.destroy();
    await expect(p).resolves.toMatchObject({ status: 'destroyed' });
  });

  it('removes the frame and stops listening', async () => {
    const { host, container } = makeHost();
    const p = host.mount();
    expect(container.querySelector('iframe')).toBeTruthy();
    host.destroy();
    await p;
    expect(container.querySelector('iframe')).toBeNull();
    expect(host.element).toBeNull();
  });

  it('does not fire a late timer after teardown', async () => {
    const { host } = makeHost({ readyTimeoutMs: 20 });
    const p = host.mount();
    host.destroy();
    const first = await p;
    await new Promise((r) => setTimeout(r, 50));
    // Still the teardown result: a cleared timer cannot overwrite it.
    expect(first.status).toBe('destroyed');
    expect(host.status.status).toBe('destroyed');
  });
});

describe('the frame is sandboxed', () => {
  it('allows scripts and nothing else', async () => {
    // With allow-same-origin as well, a frame can remove its own sandbox
    // attribute — which is the same as having none. A block can come from the
    // shipped library, another user's published work, or the agent.
    const { host } = makeHost();
    const p = host.mount();
    expect(host.element!.getAttribute('sandbox')).toBe('allow-scripts');
    host.destroy();
    await p;
  });

  it('is created at frame size and scaled, not resized', async () => {
    // Sizing the element to the box would re-run the block's layout at another
    // width, and for a pixel-designed block that is a different design.
    const { host } = makeHost();
    const p = host.mount();
    expect(host.element!.width).toBe('1920');
    const scale = host.fitInto({ width: 960, height: 1000 });
    expect(scale).toBeCloseTo(0.5);
    expect(host.element!.style.transform).toBe('scale(0.5)');
    expect(host.element!.width).toBe('1920');
    host.destroy();
    await p;
  });
});

describe('mounting twice', () => {
  /**
   * A re-render or a React strict-mode double-effect calls this twice. It used
   * to build a second frame, orphan the first in the DOM, and overwrite the
   * pending resolver — so the FIRST promise never settled. A leak and a hang
   * from one duplicated call.
   */
  it('returns the same mount rather than building a second frame', async () => {
    const { host, container } = makeHost();
    const a = host.mount();
    const b = host.mount();
    expect(a).toBe(b);
    expect(container.querySelectorAll('iframe').length).toBe(1);
    settleAs(host, 'ok');
    await expect(a).resolves.toMatchObject({ status: 'ready' });
  });

  it('settles BOTH callers, not just the later one', async () => {
    const { host } = makeHost();
    const first = host.mount();
    host.mount();
    settleAs(host, 'ok');
    // The bug was that the first caller waited for a resolver that had been
    // replaced, so this is the assertion that would have hung.
    await expect(first).resolves.toMatchObject({ status: 'ready' });
  });

  it('can mount again after being destroyed', async () => {
    const { host, container } = makeHost();
    const p = host.mount();
    host.destroy();
    await p;
    const again = host.mount();
    expect(container.querySelectorAll('iframe').length).toBe(1);
    settleAs(host, 'ok');
    await expect(again).resolves.toMatchObject({ status: 'ready' });
  });
});
