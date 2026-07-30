import { describe, it, expect, beforeEach, vi } from 'vitest';
import { redirectToAgentHost } from './agent-host-redirect';

/**
 * The guarantee: the image editor is never used without its agent, whatever URL
 * you arrive on. Links can be repointed one by one, but a bookmark, an old tab,
 * or an entry point nobody remembered would still land on the bare editor — and
 * nothing tells the user the assistant is missing. These pin the enforcement.
 *
 * The loop hazard is the important one: /ai/image EMBEDS /image/, so if the
 * embedded copy also redirected, the page would bounce forever.
 */

let replaced: string | null = null;

function setLocation(href: string, framed = false) {
  replaced = null;
  const url = new URL(href);
  vi.stubGlobal('window', {
    location: {
      href,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      replace: (t: string) => { replaced = t; },
    },
    // Framed → window.top is a DIFFERENT object from window.self.
    top: framed ? {} : undefined as any,
    self: undefined as any,
  });
  // Make top === self for the un-framed case.
  const w = globalThis.window as any;
  w.self = w;
  if (!framed) w.top = w;
}

describe('agent-host redirect', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('sends a bare /image/ load to the agent-hosted page', () => {
    setLocation('https://voidspace.ai/image/');
    expect(redirectToAgentHost()).toBe(true);
    expect(replaced).toBe('/ai/image');
  });

  it('handles /image/index.html the same way', () => {
    setLocation('https://voidspace.ai/image/index.html');
    expect(redirectToAgentHost()).toBe(true);
    expect(replaced).toBe('/ai/image');
  });

  it('carries the project through — the user clicked a specific project', () => {
    setLocation('http://localhost:3006/image/?project=1785426036838-1804upoa2');
    expect(redirectToAgentHost()).toBe(true);
    expect(replaced).toBe('/ai/image?project=1785426036838-1804upoa2');
  });

  it('carries a carousel deep link through', () => {
    setLocation('https://voidspace.ai/image/?carousel=draft-carousel-99');
    expect(redirectToAgentHost()).toBe(true);
    expect(replaced).toBe('/ai/image?carousel=draft-carousel-99');
  });

  it('carries the whole "edit this image" handoff, including from=', () => {
    setLocation('https://voidspace.ai/image/?src=https%3A%2F%2Fx.com%2Fa.png&from=Studio');
    expect(redirectToAgentHost()).toBe(true);
    expect(replaced).toBe('/ai/image?src=https%3A%2F%2Fx.com%2Fa.png&from=Studio');
  });

  it('preserves the hash as well as the query', () => {
    setLocation('https://voidspace.ai/image/?project=p1#layers');
    expect(redirectToAgentHost()).toBe(true);
    expect(replaced).toBe('/ai/image?project=p1#layers');
  });

  it('does NOT redirect when embedded — that is the hosted case', () => {
    // /ai/image embeds /image/. If the embedded copy redirected too, the
    // host page would load a page that navigates itself, forever.
    setLocation('https://voidspace.ai/image/?project=p1&embed=1', true);
    expect(redirectToAgentHost()).toBe(false);
    expect(replaced).toBeNull();
  });

  it('honours ?standalone=1 as a deliberate escape hatch', () => {
    setLocation('https://voidspace.ai/image/?standalone=1');
    expect(redirectToAgentHost()).toBe(false);
    expect(replaced).toBeNull();
  });

  it('never hijacks a different path that happens to load this bundle', () => {
    setLocation('https://voidspace.ai/ai/image');
    expect(redirectToAgentHost()).toBe(false);
    expect(replaced).toBeNull();
  });

  it('treats a cross-origin ancestor as embedded rather than risking a loop', () => {
    vi.stubGlobal('window', {
      get top() { throw new Error('cross-origin'); },
      self: {},
      location: { href: 'https://voidspace.ai/image/', pathname: '/image/', search: '', hash: '', replace: () => {} },
    });
    expect(redirectToAgentHost()).toBe(false);
  });
});
