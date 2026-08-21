import { describe, expect, it } from 'vitest';

import { blockSrcdoc } from './block-render';

/**
 * The runtime half of the publish defence.
 *
 * The static check is a substring scan and is beatable by string construction;
 * the browser is not. These two layers were designed together, and the property
 * worth pinning is that they apply to the right blocks: somebody else's run in a
 * box, your own run as you wrote them.
 */
const HTML = '<!doctype html><html><head><style>body{margin:0}</style></head>'
  + '<body><div class="h">Hi</div><script>console.log(1)</script></body></html>';

describe('untrusted blocks render under a Content-Security-Policy', () => {
  it('injects a policy that forbids the network and nested frames', () => {
    const out = blockSrcdoc(HTML, {}, 'p1', [], { untrusted: true });
    expect(out).toContain('Content-Security-Policy');
    expect(out).toContain("connect-src 'none'");
    expect(out).toContain("frame-src 'none'");
    expect(out).toContain("default-src 'none'");
  });

  /**
   * A meta CSP applies from where it is parsed. A script above it would already
   * have run unpoliced, so its POSITION is the whole guarantee.
   */
  it('puts the policy before anything the block brought with it', () => {
    const out = blockSrcdoc(HTML, {}, 'p1', [], { untrusted: true });
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('console.log'));
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('__vsPreviewId'));
  });

  it('still allows what a legitimate block needs — inline style, inline script, data images', () => {
    const out = blockSrcdoc(HTML, {}, 'p1', [], { untrusted: true });
    expect(out).toContain("script-src 'unsafe-inline'");
    expect(out).toContain("style-src 'unsafe-inline'");
    expect(out).toContain('img-src data: blob:');
  });

  /**
   * 113 shipped blocks load GSAP from a CDN. Applying the policy to a user's own
   * library would black most of it out to defend against their own files running
   * on their own machine, which is not a threat.
   */
  it('does NOT police the user\'s own blocks', () => {
    const out = blockSrcdoc(HTML, {}, 'p1', []);
    expect(out).not.toContain('Content-Security-Policy');
  });

  it('defaults to trusted when no options are passed, so existing callers are unchanged', () => {
    expect(blockSrcdoc(HTML)).not.toContain('Content-Security-Policy');
    expect(blockSrcdoc(HTML, {}, 'x', [], {})).not.toContain('Content-Security-Policy');
  });
});
