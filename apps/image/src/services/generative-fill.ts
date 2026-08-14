// generative-fill.ts
// -----------------------------------------------------------------------------
// Photoshop-style Generative Fill = TRUE masked inpainting. The caller renders
// the FULL composite + a mask (WHITE = the selected region to regenerate, BLACK
// = keep — FLUX Fill convention) at matching dimensions; we upload both and run
// fal.ai FLUX.1 [dev] Inpainting via /api/studio/gen-fill (authed + billed).
// Only the masked pixels are regenerated, conditioned on the whole image, so it
// blends seamlessly. The editor drops the result on a new layer masked to the
// selection (non-destructive).
// -----------------------------------------------------------------------------

import { getVoidspaceIdToken, NotSignedInError } from './voidspace-storage';

/** Generative-fill failure, classified by HTTP status — NO server/provider text
 *  is carried, so the UI can show clean copy (402 = user out of credits;
 *  503 = our provider is temporarily unavailable; else = generic failure). */
export class GenFillError extends Error {
  code: number;
  available?: number;
  required?: number;
  constructor(code: number, info: { available?: number; required?: number } = {}) {
    super(`gen-fill ${code}`);
    this.name = 'GenFillError';
    this.code = code;
    this.available = info.available;
    this.required = info.required;
  }
}

/**
 * A LOCAL fill that failed, carrying the reason.
 *
 * ── WHY THIS IS NOT `GenFillError` ──────────────────────────────────────────
 * `GenFillError` deliberately carries no server text: a cloud fill goes through
 * a provider, and provider internals have no business reaching a user's screen.
 * That rule is right, and applying it here was wrong. A local fill has no
 * provider — it is the user's own ComfyUI on their own machine, and the message
 * is the single most useful thing we have: which weight file is missing, which
 * node errored, that they need to start ComfyUI.
 *
 * The whole client surfaces ComfyUI's own errors verbatim precisely so this
 * moment is diagnosable. Reducing it to "Couldn't generate. Please try again."
 * at the final hop threw all of that away.
 */
export class LocalFillError extends Error {
  /** HTTP status, when the failure was the request rather than the render. */
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'LocalFillError';
    this.status = status;
  }
}

/** The user's billing situation, used to tailor the out-of-credits popup
 *  (subscribed → top up; not → subscribe). Best-effort; defaults to not-subscribed. */
export async function fetchCreditSituation(): Promise<{ isSubscribed: boolean }> {
  try {
    const token = await getVoidspaceIdToken();
    if (!token) return { isSubscribed: false };
    const res = await fetch('/api/me/subscription-status', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return { isSubscribed: false };
    const j = await res.json();
    return { isSubscribed: j?.isSubscribed === true };
  } catch {
    return { isSubscribed: false };
  }
}

/** Fill models the user can pick, with their credit cost (per ~1MP fill).
 *  engine 'fal' = true masked inpainting (FLUX Fill), pixel-locked by the model.
 *  engine 'kie' = mask-free editor (nano-banana / gpt-image-2): regenerates the
 *                 whole frame, so we outline the selection + composite only its
 *                 region back (outside stays untouched).
 *  refMode 'none' | 'optional' | 'required' drives the reference-image UI. */
export const FILL_MODELS = [
  { id: 'seedream-5-pro', label: 'Seedream 5.0 Pro (edit)', credits: 4, engine: 'kie', refMode: 'optional' },
  { id: 'flux-dev-inpaint', label: 'FLUX.1 Fill (dev)', credits: 4, engine: 'fal', refMode: 'none' },
  { id: 'flux-pro-fill', label: 'FLUX.1 Fill (pro)', credits: 6, engine: 'fal', refMode: 'none' },
  { id: 'flux-kontext-ref', label: 'FLUX Kontext (reference)', credits: 4, engine: 'fal', refMode: 'required' },
  { id: 'nano-banana-2', label: 'Nano Banana (reference edit)', credits: 5, engine: 'kie', refMode: 'optional' },
  { id: 'gpt-image-2', label: 'GPT Image 2 (edit)', credits: 4, engine: 'kie', refMode: 'optional' },
] as const;

/** Widened to a plain string: a LOCAL model's id is `local:<node>/<recipe>` and
 *  is only known at runtime, so it cannot be part of a literal union. The cloud
 *  ids above still autocomplete because they are what the array holds. */
export type FillModelId = typeof FILL_MODELS[number]['id'] | (string & {});

/** One entry in the picker — cloud or local. */
export interface FillModelOption {
  id: string;
  label: string;
  credits: number;
  engine: 'fal' | 'kie' | 'local';
  refMode: 'none' | 'optional' | 'required';
  /** Local only: whether the machine can run it, and what it needs if not. */
  local?: { nodeName: string; ready: boolean; missing?: string };
}

/**
 * Models the user can fill with, INCLUDING any on their own hardware.
 *
 * ── WHY THIS IS FETCHED AND NOT A CONSTANT ──────────────────────────────────
 * A cloud model exists for everyone. A local one exists only while a particular
 * machine of theirs is switched on, so the list genuinely differs per request and
 * cannot be baked in. `/api/studio/models` already merges the two — that endpoint
 * is the single catalogue every picker in the product reads, which is what stops
 * this from becoming a second source of truth about what exists.
 *
 * Falls back to the static cloud list if the catalogue cannot be reached: the
 * editor must keep working offline-ish, and a picker that empties itself because
 * a fetch failed is worse than one that is merely missing the local rows.
 */
export async function loadFillModels(): Promise<FillModelOption[]> {
  const cloud: FillModelOption[] = FILL_MODELS.map((m) => ({ ...m }));
  try {
    const token = await getVoidspaceIdToken();
    if (!token) return cloud;
    const res = await fetch('/api/studio/models?category=image', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return cloud;
    const j = await res.json();
    const local: FillModelOption[] = (j?.models ?? [])
      .filter((m: any) => m?.surface === 'local' && m?.local)
      // Only workflows that EDIT. A text-to-image recipe cannot honour a mask,
      // and offering it here would produce a full-frame replacement that the
      // editor would then crop to the selection — a confusing, expensive no-op.
      .filter((m: any) => ['image.inpaint', 'image.edit'].includes(m.local?.task ?? ''))
      .map((m: any) => ({
        id: m.id,
        label: m.label,
        credits: 0,
        engine: 'local' as const,
        refMode: 'none' as const,
        local: { nodeName: m.local.nodeName, ready: !!m.local.ready, missing: m.local.missing },
      }));
    // Ready local models FIRST: someone who has set up their own GPU wants it to
    // be the obvious choice, not something they scroll past. Unready ones go last
    // — visible, so the setup is discoverable, but never the default.
    return [
      ...local.filter((m) => m.local?.ready),
      ...cloud,
      ...local.filter((m) => !m.local?.ready),
    ];
  } catch {
    return cloud;
  }
}

/** The engine backing a model id (defaults to 'fal'). */
export function fillEngine(id: FillModelId): 'fal' | 'kie' | 'local' {
  // Checked by ID SHAPE, not by a lookup: the picker's list is async, and a fill
  // can be triggered (agent tool, re-run of a saved layer) before it has loaded.
  // The `local:` scheme is `registry.ts#LOCAL_MODEL_PREFIX`.
  if (typeof id === 'string' && id.startsWith('local:')) return 'local';
  return (FILL_MODELS.find((m) => m.id === id)?.engine ?? 'fal') as 'fal' | 'kie';
}

async function uploadTemp(blob: Blob, name: string, token: string): Promise<string> {
  const file = new File([blob], name, { type: blob.type || 'image/png' });
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/studio/upload-temp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
  const j = await res.json();
  const url = j.url || j.fileUrl;
  if (!url) throw new Error('upload returned no url');
  return url;
}

/** Upload a user-picked reference image to Kie temp; returns its public URL
 *  (passed to reference-guided inpaint models as reference_image_url). */
export async function uploadReferenceImage(file: File): Promise<string> {
  const token = await getVoidspaceIdToken();
  if (!token) throw new NotSignedInError();
  return uploadTemp(file, file.name || 'reference.png', token);
}

/** Upload a reference image from a REMOTE URL (e.g. an image dragged in from the
 *  web). The server fetches + recompresses it (upload-temp's sourceUrl branch),
 *  so the browser never has to fetch a cross-origin/CSP-blocked image itself. */
export async function uploadReferenceFromUrl(sourceUrl: string): Promise<string> {
  const token = await getVoidspaceIdToken();
  if (!token) throw new NotSignedInError();
  const res = await fetch('/api/studio/upload-temp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceUrl }),
  });
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
  const j = await res.json();
  const url = j.url || j.fileUrl;
  if (!url) throw new Error('upload returned no url');
  return url;
}

export interface GenerativeFillOpts {
  imageBlob: Blob;   // full composite (PNG/JPEG)
  maskBlob: Blob;    // same dimensions; WHITE = inpaint, BLACK = keep
  prompt: string;
  model?: FillModelId;
  /** Public URL of an already-uploaded reference image (for ref models). */
  referenceUrl?: string;
}

/** Classify a failed /gen-fill response by status ONLY (never surface server
 *  text) and throw the matching GenFillError. */
async function throwGenFillError(res: Response): Promise<never> {
  let available: number | undefined;
  let required: number | undefined;
  try {
    const j = await res.json();
    available = j?.data?.available ?? j?.available;
    required = j?.data?.required ?? j?.required;
  } catch { /* ignore */ }
  throw new GenFillError(res.status, { available, required });
}

/** Fetch a result image URL and return it as a data URL. */
/**
 * Fetch a result and return it as a data URL.
 *
 * ── WHY THE TOKEN IS NOT OPTIONAL FOR A LOCAL RESULT ────────────────────────
 * The cloud paths hand this a PUBLIC provider URL (Kie, fal), which needs no
 * credentials — which is why it was written without any. A local result is the
 * opposite: `/api/studio/local-gen-file` serves bytes off the user's own disk and
 * is gated by `requireUserId`, so a bare fetch gets a 401.
 *
 * That produced the single worst failure shape in this whole feature. The render
 * SUCCEEDED — GPU spiked, the node logged the saved file, the job read `done` —
 * and then the browser could not collect it, so the user saw a failure for work
 * that had actually been done. Every server-side test passed because they all set
 * the header explicitly; only a real browser could find this.
 *
 * A `data:` URL is passed through untouched: the mesh path already carries the
 * bytes inline (no route to a remote node's disk exists) and re-fetching it would
 * be a pointless round trip through the FileReader.
 */
/** Test seam for the auth rule above. Exported under a deliberately awkward name
 *  so it reads as internal at every call site: the rule it guards (token for
 *  same-origin, never for a provider) shipped wrong once and cannot be verified
 *  from outside a browser any other way. */
export const __fetchResultForTest = (url: string, token?: string) => fetchAsDataUrl(url, token);

async function fetchAsDataUrl(url: string, token?: string): Promise<string> {
  if (url.startsWith('data:')) return url;
  // Same-origin means it is one of ours and therefore authed. An absolute
  // provider URL must NOT receive the token — sending a Voidspace bearer to a
  // third party would leak it.
  const sameOrigin = url.startsWith('/') || url.startsWith(window.location.origin);
  const imgRes = await fetch(url, {
    headers: sameOrigin && token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!imgRes.ok) throw new Error(`fetch result failed (${imgRes.status})`);
  const blob = await imgRes.blob();
  return await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/** Run masked inpainting (fal FLUX Fill). Returns the result as a data URL. */
export async function runGenerativeFill(opts: GenerativeFillOpts): Promise<string> {
  const token = await getVoidspaceIdToken();
  if (!token) throw new NotSignedInError();

  const [imageUrl, maskUrl] = await Promise.all([
    uploadTemp(opts.imageBlob, 'fill-source.png', token),
    uploadTemp(opts.maskBlob, 'fill-mask.png', token),
  ]);

  const res = await fetch('/api/studio/gen-fill', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageUrl, maskUrl, prompt: opts.prompt, model: opts.model, referenceUrl: opts.referenceUrl }),
  });
  if (!res.ok) await throwGenFillError(res);
  const j = await res.json();
  const resultUrl: string = j.url;
  if (!resultUrl) throw new Error('Generative fill returned no image');
  return fetchAsDataUrl(resultUrl);
}

/**
 * Run a masked fill on the USER'S OWN MACHINE. Returns the result as a data URL.
 *
 * ── WHAT IS DELETED HERE, NOT ADAPTED ───────────────────────────────────────
 * The cloud paths above begin by uploading the composite and the mask to Kie's
 * temp storage, because fal and Kie need a public URL to fetch from. This path
 * has no upload at all — the bytes go to the website, which hands them to a node
 * on the same machine. That absence IS the privacy property of local editing: the
 * user's photograph never leaves their computer, and it has to be true in the code
 * rather than merely claimed.
 *
 * ── WHY IT POLLS ────────────────────────────────────────────────────────────
 * An inpaint is seconds on a 4090 and a minute on a laptop GPU, and the node runs
 * it as a job. Polling means a reload does not abandon a render that is still
 * going — the same reason `gen-clip-start` was split from its status call.
 */
export async function runLocalFill(opts: {
  imageBlob: Blob;
  maskBlob: Blob;
  prompt: string;
  model: FillModelId;
  negative?: string;
  seed?: number;
  onProgress?: (phase: string, pct: number | null) => void;
}): Promise<string> {
  const token = await getVoidspaceIdToken();
  if (!token) throw new NotSignedInError();

  const form = new FormData();
  form.append('model', String(opts.model));
  form.append('prompt', opts.prompt ?? '');
  if (opts.negative) form.append('negative', opts.negative);
  if (Number.isFinite(opts.seed)) form.append('seed', String(opts.seed));
  form.append('image', new File([opts.imageBlob], 'fill-source.png', { type: 'image/png' }));
  form.append('mask', new File([opts.maskBlob], 'fill-mask.png', { type: 'image/png' }));

  const res = await fetch('/api/studio/local-gen-fill', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    /**
     * A MISSING ROUTE IS ITS OWN DIAGNOSIS.
     *
     * The website server is what carries the local-generation routes, and a
     * build that predates them answers with a redirect to the SPA shell or a
     * 404 — never JSON. Reported as "try again" that is unfixable advice for a
     * problem retrying cannot touch, and it is exactly what happens when the
     * editor bundle is newer than the server it is talking to.
     */
    if (res.status === 404 || res.status === 302 || res.redirected) {
      throw new LocalFillError(
        'This website build does not support local generation yet — its server is older than the editor.',
        res.status,
      );
    }
    // The server's own sentence, which for a local failure names the exact
    // thing to fix (a weight file, ComfyUI being closed).
    let detail = '';
    try {
      const j = await res.clone().json();
      detail = String(j?.statusMessage || j?.message || j?.data?.error || '');
    } catch {
      detail = (await res.text().catch(() => '')).slice(0, 300);
    }
    throw new LocalFillError(
      detail || `The local render could not start (HTTP ${res.status}).`,
      res.status,
    );
  }
  const started = await res.json();
  const jobId: string = started?.jobId;
  if (!jobId) throw new LocalFillError('The local fill did not start.');
  // Echoed on every poll. A job id only means something on the node that owns
  // it, so with a workstation and a laptop both online, losing this would ask
  // the wrong machine and report a perfectly healthy render as missing.
  const via: string = started?.via ?? 'loopback';
  const node: string | undefined = started?.node;

  // ~15 min. An inpaint that has not finished by then is wedged, and a poll loop
  // with no ceiling is a spinner that never resolves.
  const DEADLINE = Date.now() + 15 * 60_000;
  while (Date.now() < DEADLINE) {
    await new Promise((r) => setTimeout(r, 1200));
    const sres = await fetch('/api/studio/local-gen-status', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, via, node }),
    });
    if (!sres.ok) {
      if (sres.status === 404) throw new LocalFillError('That local render is no longer on this machine.', 404);
      continue;                       // a blip; the job is safe on the node
    }
    const p = await sres.json();
    if (p.state === 'running') {
      const pct = typeof p.progress?.pct === 'number' ? p.progress.pct : null;
      opts.onProgress?.(String(p.progress?.phase ?? 'rendering'), pct);
      continue;
    }
    if (p.state === 'failed' || p.state === 'cancelled') {
      // ComfyUI's own message, carried the whole way — it names the node and the
      // missing file. Ours would say "generation failed".
      throw new LocalFillError(p.message || p.logTail?.slice(-1)[0] || 'The local fill failed.');
    }
    if (!p.url) throw new LocalFillError('The local fill produced no image.');
    // The token: this URL is ours and authed. See fetchAsDataUrl.
    return fetchAsDataUrl(p.url, token);
  }
  throw new LocalFillError('The local fill timed out.');
}

/** Run a mask-free Kie edit (nano-banana / gpt-image-2). Uploads the outlined
 *  composite + sends any reference URLs; returns the FULL result as a data URL
 *  (the caller composites only the selection region back). */
export async function runKieEditFill(opts: {
  markedBlob: Blob;
  referenceUrls: string[];
  prompt: string;
  model: FillModelId;
  aspectRatio?: string;
  inverted?: boolean;
}): Promise<string> {
  const token = await getVoidspaceIdToken();
  if (!token) throw new NotSignedInError();

  const imageUrl = await uploadTemp(opts.markedBlob, 'fill-marked.png', token);

  const res = await fetch('/api/studio/gen-fill', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      engine: 'kie', model: opts.model, imageUrl,
      referenceUrls: opts.referenceUrls, prompt: opts.prompt,
      aspectRatio: opts.aspectRatio, inverted: opts.inverted === true,
    }),
  });
  if (!res.ok) await throwGenFillError(res);
  const j = await res.json();
  const resultUrl: string = j.url;
  if (!resultUrl) throw new Error('Generative fill returned no image');
  return fetchAsDataUrl(resultUrl);
}
