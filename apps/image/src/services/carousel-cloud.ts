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
 * Open a cloud carousel as a multi-page editor project. Page N = slide N.
 *
 * IMPORTANT: each page/artboard is sized to the slide image's ACTUAL pixel
 * dimensions (not the carousel's declared aspect_ratio), so the image is placed
 * 1:1 with no stretching. The declared aspect_ratio is only a fallback when an
 * image's dimensions can't be read. Uses the validated store actions so the
 * project is well-formed; autosave persists it locally. Switches to the editor.
 */
export async function openCloudCarousel(c: CloudCarousel): Promise<void> {
  const P = useProjectStore.getState();
  const fallback = aspectRatioToSize(c.aspectRatio);
  let created = false;

  for (let i = 0; i < c.imageUrls.length; i++) {
    let img: { dataUrl: string; width: number; height: number };
    try {
      img = await fetchImageAsDataUrl(c.imageUrls[i]);
    } catch (e) {
      // A single unreachable slide shouldn't break the whole open — skip it.
      console.warn('[carousel-cloud] slide load failed:', c.imageUrls[i], e);
      continue;
    }
    // The page is exactly the image's real size → aspect ratio preserved,
    // image placed full-bleed at native dimensions (no distortion).
    const size = {
      width: Math.max(1, Math.round(img.width || fallback.width)),
      height: Math.max(1, Math.round(img.height || fallback.height)),
    };

    if (!created) {
      P.createProject(c.name || 'Carousel', size);
      created = true;
    } else {
      const artboardId = P.addArtboard(`Page ${i + 1}`, size);
      P.selectArtboard(artboardId);
    }

    const asset: MediaAsset = {
      id: `carousel-${c.id}-${i}`,
      name: `Slide ${i + 1}`,
      type: 'image',
      mimeType: 'image/png',
      size: img.dataUrl.length,
      width: size.width,
      height: size.height,
      thumbnailUrl: img.dataUrl,
      dataUrl: img.dataUrl,
    };
    P.addAsset(asset);
    P.addImageLayer(asset.id, { x: 0, y: 0, width: size.width, height: size.height });
  }

  // Every slide failed → still give the editor a (blank) project to show.
  if (!created) P.createProject(c.name || 'Carousel', fallback);

  // Back to page 1 for editing.
  const first = useProjectStore.getState().project?.artboards[0];
  if (first) P.selectArtboard(first.id);
  useUIStore.getState().setCurrentView('editor');
}
