import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Some library video masters (ProRes/DNxHD .mov, common in stock VFX packs) are
 * decoded fine by the server's ffmpeg thumbnailer but by no browser's <video>
 * element — the poster renders, playback never starts. The server already
 * exposes a transcoded H.264 proxy for exactly this case (`proxyUrl` on
 * media-library search results); this only needed to be wired up client-side.
 *
 * Polls at the server's own pace (`retryAfterMs`) rather than a fixed interval,
 * so a saturated transcode queue is not hammered by every open tile.
 */
async function pollProxyReady(url: string, signal: AbortSignal): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (signal.aborted) return false;
    let res: Response;
    try {
      res = await fetch(url, { signal, cache: "no-store" });
    } catch {
      return false;
    }
    if (res.status === 200) return true;
    if (res.status !== 202) return false;
    let waitMs = 4000;
    try {
      const body = await res.json();
      if (typeof body?.retryAfterMs === "number") waitMs = body.retryAfterMs;
    } catch {
      /* keep default */
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return false;
}

/**
 * A video source that falls back to a transcoded proxy when the original
 * cannot be decoded. Tries the original first — free for the common
 * H.264/VP9 case — and only pays for a transcode when playback genuinely
 * fails to start.
 *
 * `rawSrc` and `proxySrc` must already carry any auth token the caller uses
 * elsewhere for `<video src>` (this hook only reacts to load failure; it does
 * not know how the caller authenticates).
 */
export function usePlayableVideo(rawSrc: string, proxySrc: string | null | undefined) {
  const [src, setSrc] = useState(rawSrc);
  const [transcoding, setTranscoding] = useState(false);
  const [failed, setFailed] = useState(false);
  const triedProxy = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setSrc(rawSrc);
    setFailed(false);
    setTranscoding(false);
    triedProxy.current = false;
    abortRef.current?.abort();
    return () => abortRef.current?.abort();
  }, [rawSrc]);

  const onError = useCallback(() => {
    if (triedProxy.current || !proxySrc) {
      setFailed(true);
      return;
    }
    triedProxy.current = true;
    setTranscoding(true);
    const ac = new AbortController();
    abortRef.current = ac;
    pollProxyReady(proxySrc, ac.signal).then((ok) => {
      if (ac.signal.aborted) return;
      setTranscoding(false);
      if (ok) setSrc(proxySrc);
      else setFailed(true);
    });
  }, [proxySrc]);

  return { src, onError, transcoding, failed };
}
