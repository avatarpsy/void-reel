/**
 * `withToken` — who is allowed to see the user's credential.
 *
 * A `?t=` query IS a bearer token, and a URL is logged by every server it
 * reaches. This file exists because the host check was missing for a while: the
 * function's own comment claimed to append the token only "when the URL is one
 * of ours" and the code appended it to everything, so one externally-hosted
 * picture on a board handed the user's Firebase ID token to a stranger's access
 * log the moment its tile painted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installParentAuth, withToken } from './parent-auth';

/** Hand the module a token the way the parent page does. */
function grantToken(token: string) {
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'voidspace:board-token', token },
  }));
}

describe('withToken', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    installParentAuth();
    grantToken('SECRET.JWT.VALUE');
  });

  it('appends the token to our own origin', () => {
    const url = `${location.origin}/api/studio/local-asset?f=a.png`;
    expect(withToken(url)).toContain('t=SECRET.JWT.VALUE');
  });

  it('appends the token to a relative url, which is also ours', () => {
    expect(withToken('/api/media/1')).toContain('t=SECRET.JWT.VALUE');
  });

  it('appends the token to a voidspace domain', () => {
    expect(withToken('https://cdn.voidspace.ai/x.mp4')).toContain('t=SECRET.JWT.VALUE');
  });

  /** THE ONE THAT MATTERS. */
  it('NEVER sends the token to a third-party host', () => {
    for (const url of [
      'https://picsum.photos/seed/1/320/180',
      'https://evil.example.com/pixel.gif',
      // A lookalike: the token must not leak to a domain that merely ends in
      // something similar.
      'https://voidspace.ai.attacker.test/x.png',
      'https://notvoidspace.ai/x.png',
    ]) {
      expect(withToken(url)).toBe(url);
      expect(withToken(url)).not.toContain('SECRET');
    }
  });

  it('leaves blob: and data: urls alone', () => {
    expect(withToken('blob:http://localhost/abc')).toBe('blob:http://localhost/abc');
    expect(withToken('data:image/png;base64,AAA')).toBe('data:image/png;base64,AAA');
  });

  it('does not append a second time', () => {
    const once = withToken('/api/media/1');
    expect(withToken(once)).toBe(once);
  });
});
