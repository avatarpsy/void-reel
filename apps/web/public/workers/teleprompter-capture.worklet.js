/**
 * Teleprompter mic capture — AudioWorkletProcessor.
 *
 * Runs on the browser's dedicated AUDIO RENDERING THREAD, so tapping the
 * recorder's microphone costs the main thread (which is compositing the live
 * preview and feeding the video encoder) essentially nothing.
 *
 * The thread it replaces mattered: ScriptProcessorNode delivers its callback on
 * the MAIN thread, so every mic tick competed with rendering the take. Here the
 * decimation and the RMS voice-activity measure happen off-thread, and the main
 * thread receives one small, already-reduced frame every ~64 ms.
 *
 * Out: { pcm: Float32Array(FRAME), rms: number } — pcm is TRANSFERRED, so there
 * is no structured-clone copy. A fresh frame buffer is allocated per message
 * (transfer neuters the old one); at ~16 messages/s of 4 KB that is noise, and
 * it keeps the protocol free of ownership bugs.
 *
 * `decimate` (processorOptions) handles platforms that refuse a 16 kHz
 * AudioContext for a MediaStream source: we open at the device rate and keep
 * every Nth sample. Phase carries across render quanta so the stride never
 * jitters.
 */

const FRAME = 1024; // ~64 ms at 16 kHz — fine-grained enough for voice activity

class TeleprompterCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.decimate = Math.max(1, Math.round(opts.decimate || 1));
    this.phase = 0;
    this.frame = new Float32Array(FRAME);
    this.filled = 0;
    this.sumSq = 0;
    this.closed = false;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === "close") this.closed = true;
    };
  }

  process(inputs) {
    if (this.closed) return false; // let the node be collected
    const input = inputs[0];
    if (!input || !input.length) return true; // no source yet — keep alive
    const ch = input[0];
    if (!ch) return true;

    const dec = this.decimate;
    for (let i = this.phase; i < ch.length; i += dec) {
      const s = ch[i];
      this.frame[this.filled++] = s;
      this.sumSq += s * s;
      if (this.filled === FRAME) {
        const pcm = this.frame;
        const rms = Math.sqrt(this.sumSq / FRAME);
        // Transfer ownership; allocate the next frame for ourselves.
        this.port.postMessage({ pcm, rms }, [pcm.buffer]);
        this.frame = new Float32Array(FRAME);
        this.filled = 0;
        this.sumSq = 0;
      }
    }
    this.phase = dec === 1 ? 0 : (this.phase + ch.length) % dec;
    return true;
  }
}

registerProcessor("teleprompter-capture", TeleprompterCaptureProcessor);
