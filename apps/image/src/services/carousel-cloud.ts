// carousel-cloud.ts
// -----------------------------------------------------------------------------
// Bridges agent-created image carousels (from Flutter or the web agent) into
// the editor. Carousels live in the shared Firestore SSOT
// (users/{uid}/social_post_drafts, content_type='carousel') — the web endpoint
// /api/studio/carousels lists them. Opening one builds a multi-artboard editor
// project: ONE page per slide, so the carousel is fully editable here. Remote
// slide images are pulled through the same-origin media-proxy to dodge CORS.
// -----------------------------------------------------------------------------

import { getVoidspaceIdToken } from './voidspace-storage';
import { aspectRatioToSize } from './image-generation';
import { useProjectStore } from '../stores/project-store';
import { useUIStore } from '../stores/ui-store';
import type { MediaAsset } from '../types/project';

export interface CloudCarousel {
  id: string;
  name: string;
  caption: string;
  aspectRatio: string;
  coverUrl: string;
  imageUrls: string[];
  sceneCount: number;
  status: string;
  updatedAt: number;
}

/** List the signed-in user's carousels (agent-created, cross-surface). */
export async function fetchCloudCarousels(): Promise<CloudCarousel[]> {
  const token = await getVoidspaceIdToken();
  if (!token) return [];
  const res = await fetch('/api/studio/carousels', { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`carousels ${res.status}`);
  const j = await res.json();
  return Array.isArray(j.carousels) ? j.carousels : [];
}

/** Open one carousel by its draft id (deep-link from the Studio projects hub's
 *  Images tab → /image/?carousel=<id>). Returns false if not found. */
export async function openCloudCarouselById(id: string): Promise<boolean> {
  const list = await fetchCloudCarousels();
  const c = list.find((x) => x.id === id);
  if (!c) return false;
  await openCloudCarousel(c);
  return true;
}

/** Append a media token to a media-proxy/cover URL so an <img> can preview it.
 *  Remote carousel URLs are public, so this is mostly a passthrough. */
export function carouselThumbUrl(url: string): string {
  if (!url) return url;
  // Route remote hosts through the CORS-fronting proxy so previews always load.
  if (/^https?:\/\//i.test(url) && !url.startsWith(window.location.origin)) {
    return `/api/studio/media-proxy?url=${encodeURIComponent(url)}`;
  }
  return url;
}

async function fetchImageAsDataUrl(url: string): Promise<{ dataUrl: string; width: number; height: number }> {
  const proxied = carouselThumbUrl(url);
  const res = await fetch(proxied);
  if (!res.ok) throw new Error(`fetch slide ${res.status}`);
  const blob = await res.blob();
  const dataUrl: string = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
  const { width, height } = await new Promise<{ width: number; height: number }>((resolve) => {
    const img = new window.Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = dataUrl;
  });
  return { dataUrl, width, height };
}

/**
 * Open a cloud carousel as a multi-page editor project. Page N = slide N,
 * full-bleed, all sized to the carousel's aspect ratio. Uses the validated
 * store actions (createProject/addArtboard/addImageLayer) so the project is
 * well-formed; autosave then persists it locally so it also joins Recent.
 * Switches the app into the editor view.
 */
export async function openCloudCarousel(c: CloudCarousel): Promise<void> {
  const P = useProjectStore.getState();
  const size = aspectRatioToSize(c.aspectRatio);

  P.createProject(c.name || 'Carousel', size);

  const addSlide = async (url: string, index: number, isFirst: boolean) => {
    if (!isFirst) {
      const artboardId = P.addArtboard(`Page ${index + 1}`, size);
      P.selectArtboard(artboardId);
    }
    try {
      const { dataUrl, width, height } = await fetchImageAsDataUrl(url);
      const asset: MediaAsset = {
        id: `carousel-${c.id}-${index}`,
        name: `Slide ${index + 1}`,
        type: 'image',
        mimeType: 'image/png',
        size: dataUrl.length,
        width: width || size.width,
        height: height || size.height,
        thumbnailUrl: dataUrl,
        dataUrl,
      };
      P.addAsset(asset);
      P.addImageLayer(asset.id, { x: 0, y: 0, width: size.width, height: size.height });
    } catch (e) {
      // A single unreachable slide shouldn't break the whole open — leave the
      // page blank so the rest of the carousel still loads.
      console.warn('[carousel-cloud] slide load failed:', url, e);
    }
  };

  for (let i = 0; i < c.imageUrls.length; i++) {
    await addSlide(c.imageUrls[i], i, i === 0);
  }

  // Back to page 1 for editing.
  const first = useProjectStore.getState().project?.artboards[0];
  if (first) P.selectArtboard(first.id);
  useUIStore.getState().setCurrentView('editor');
}
