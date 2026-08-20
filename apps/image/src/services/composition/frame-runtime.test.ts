/**
 * The in-frame runtime is a source string, so what can be checked without a
 * browser is that the protocol it implements is present and that the sequences
 * which silently break it are absent.
 *
 * It used to rasterise too. That was removed after measuring, not after
 * theorising — see the note in the module. The tests that pinned capture went
 * with it rather than being left to describe a feature nobody can use.
 */
import { describe, it, expect } from 'vitest';
import { frameRuntimeSource, MAX_CANVAS_DIMENSION, MAX_CANVAS_AREA } from './frame-runtime';

const src = (over: Partial<Parameters<typeof frameRuntimeSource>[0]> = {}) =>
  frameRuntimeSource({ poseTime: 'end', timeoutMs: 8000, expectsTimeline: true, ...over });

describe('the settle protocol', () => {
  it('seeks to the settled end state by default', () => {
    // A still of an unplayed block is blank: data-chart draws bars at height 0.
    expect(src()).toMatch(/POSE = "end"/);
    expect(src()).toMatch(/tl\.progress\(1\)/);
  });

  it('honours an explicit pose time, for scrubbing one frame', () => {
    expect(src({ poseTime: 2.5 })).toMatch(/POSE = 2\.5/);
  });

  it('seeks every registered timeline, not just the first', () => {
    // One document can host more than one composition, and a half-seeked frame
    // is the blank-chart bug in a subtler form.
    expect(src()).toMatch(/for \(var id in reg\)/);
  });

  it('skips the timeline wait when no animation runtime is present', () => {
    // 15 of the 128 shipped blocks carry no GSAP. Waiting for a timeline that is
    // never coming cost the whole timeout on every render of those — measured at
    // ~8000 ms, against 123 ms once this was in.
    expect(src({ expectsTimeline: false })).toMatch(/EXPECTS_TIMELINE = false/);
    expect(src()).toMatch(/if \(!EXPECTS_TIMELINE\) return Promise\.resolve\(false\)/);
  });

  it('seeks after assets settle, not before', () => {
    // Seeking first lets a late image resize its container underneath a layout
    // that was already finished.
    const s = src();
    expect(s.indexOf('Promise.all([fonts(), images(), subresources()])'))
      .toBeLessThan(s.indexOf('var seeked = seek();'));
  });

  it('waits for the load event, so a CSS background image is not missed', () => {
    // A background-image is in neither document.images nor the font set.
    expect(src()).toMatch(/function subresources/);
  });

  it('carries a bounded timeout, so a missing font cannot hang a render', () => {
    expect(src({ timeoutMs: 1234 })).toMatch(/TIMEOUT = 1234/);
  });
});

describe('answering a host that asked late', () => {
  it('latches the outcome before broadcasting it', () => {
    expect(src()).toMatch(/window\.__compositionReady\s*=/);
    expect(src()).toMatch(/data-composition-ready/);
  });

  it('answers a ping, the only route open to a sandboxed host', () => {
    // A sandboxed frame has an opaque origin, so the latch is unreadable from
    // outside and re-asking is the only way back. Observed in a browser: a
    // listener attached one second late saw nothing while the frame was settled.
    expect(src()).toMatch(/'ping'/);
  });

  it('says pending rather than nothing when asked before it has settled', () => {
    expect(src()).toMatch(/pending/);
  });
});

describe('sequences that silently truncate or break the runtime', () => {
  it('contains no backtick, because it is built inside a template literal', () => {
    // One backtick ends the enclosing literal and the syntax error surfaces
    // somewhere else entirely. This has already happened here once.
    expect(src()).not.toMatch(/`/);
  });

  it('contains no literal closing script tag, which truncates it where it sits', () => {
    // Injected as inline script content, an HTML parser ends the element at the
    // first closing tag it sees — even inside a comment. This runtime once lost
    // everything past character 3802, including its own message listener: the
    // frame loaded, animated, registered its timeline and then answered nothing.
    expect(src()).not.toContain('</' + 'script>');
  });
});

describe('raster limits are still declared', () => {
  it('states the ceiling any raster target has to respect', () => {
    // Kept after in-frame capture was removed: they bound what a SERVER-side
    // raster can hold too. A0 at 300dpi is ~140 megapixels.
    expect(MAX_CANVAS_DIMENSION).toBe(16384);
    expect(MAX_CANVAS_AREA).toBeLessThan(MAX_CANVAS_DIMENSION * MAX_CANVAS_DIMENSION);
  });
});
