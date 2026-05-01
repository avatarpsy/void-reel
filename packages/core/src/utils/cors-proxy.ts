/**
 * Cross-origin asset URLs from third-party hosts (Kie tempfile, Grok
 * tempfile, R2 buckets without configured CORS, etc.) hit the
 * browser's CORS wall and produce noisy `net::ERR_FAILED` console
 * floods every time the editor tries to hydrate a blob. This helper
 * rewrites such URLs to the same-origin
 * `/api/studio/media-proxy?url=...` endpoint that the Voidspace
 * website serves with `Access-Control-Allow-Origin: *`.
 *
 * Same-origin URLs, blob:, and data: URLs pass through unchanged so
 * standalone openreel deployments (no proxy mounted) keep working.
 */
export function rewriteToProxy(rawUrl: string | null | undefined): string {
  if (!rawUrl) return rawUrl as string;
  if (typeof rawUrl !== "string") return rawUrl as string;
  if (rawUrl.startsWith("blob:") || rawUrl.startsWith("data:")) return rawUrl;
  if (typeof window === "undefined") return rawUrl;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, window.location.origin);
  } catch {
    return rawUrl;
  }
  if (parsed.origin === window.location.origin) return rawUrl;
  return `${window.location.origin}/api/studio/media-proxy?url=${encodeURIComponent(parsed.toString())}`;
}
