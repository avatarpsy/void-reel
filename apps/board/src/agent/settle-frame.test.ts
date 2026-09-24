import { afterEach, describe, expect, it, vi } from 'vitest';
import { settleFrame } from './settle-frame';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('background capture layout', () => {
  it('continues when Chromium never delivers an animation frame', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 42));
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const done = vi.fn();
    const capture = settleFrame().then(done);
    await vi.advanceTimersByTimeAsync(100);
    await capture;
    expect(done).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith(42);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses a normal frame immediately and clears the fallback timer', async () => {
    vi.useFakeTimers();
    let paint!: FrameRequestCallback;
    vi.stubGlobal('requestAnimationFrame', vi.fn(cb => { paint = cb; return 7; }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const capture = settleFrame();
    paint(16);
    await capture;
    expect(vi.getTimerCount()).toBe(0);
  });
});
