// project-cloud-open.ts
// -----------------------------------------------------------------------------
// Cross-device fallback for reopening an image-editor project from the Studio
// Images tab. The full, layer-preserving project lives in the ORIGINAL browser's
// local IndexedDB; on any other device that copy isn't present, so we rebuild a
// FLATTENED project from the per-page thumbnails stored in the cloud (one image
// layer per page). The user can keep editing — each page comes back as an image
// layer they can add to, mask, etc. — they just don't get the original layer
// tree that only exists on the device the project was made on.
// -----------------------------------------------------------------------------

import { getVoidspaceIdToken } from './voidspace-storage';
import { useProjectStore } from '../stores/project-store';
import { useUIStore } from '../stores/ui-store';
import { aspectRatioToSize } from './image-generation';
import type { MediaAsset } from '../types/project';

interface CloudImageProject {
  projectId: string;
  name: string;
  aspectRatio: string;
  pageCount: number;
  cover: string;
  pages: string[];
}

function imageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = dataUrl;
  });
}

/**
 * Open the cloud project <id> as a flattened multi-page editor project (page N =
 * one full-bleed image layer). Returns false if it isn't found. Switches to the
 * editor when at least one page loads.
 */
export async function openCloudImageProject(id: string): Promise<boolean> {
  const token = await getVoidspaceIdToken();
  if (!token) return false;

  const res = await fetch(`/api/studio/image-project?id=${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return false;
  const j = (await res.json()) as { project: CloudImageProject | null };
  const proj = j.project;
  if (!proj) return false;

  const images = proj.pages.length ? proj.pages : proj.cover ? [proj.cover] : [];
  if (!images.length) return false;

  const P = useProjectStore.getState();
  const fallback = aspectRatioToSize(proj.aspectRatio);
  let created = false;

  for (let i = 0; i < images.length; i++) {
    const { width, height } = await imageSize(images[i]);
    const size = {
      width: Math.max(1, Math.round(width || fallback.width)),
      height: Math.max(1, Math.round(height || fallback.height)),
    };

    if (!created) {
      P.createProject(proj.name || 'Image project', size);
      created = true;
    } else {
      const artboardId = P.addArtboard(`Page ${i + 1}`, size);
      P.selectArtboard(artboardId);
    }

    const asset: MediaAsset = {
      id: `imgproj-${proj.projectId}-${i}`,
      name: `Page ${i + 1}`,
      type: 'image',
      mimeType: 'image/jpeg',
      size: images[i].length,
      width: size.width,
      height: size.height,
      thumbnailUrl: images[i],
      dataUrl: images[i],
    };
    P.addAsset(asset);
    P.addImageLayer(asset.id, { x: 0, y: 0, width: size.width, height: size.height });
  }

  const first = useProjectStore.getState().project?.artboards[0];
  if (first) P.selectArtboard(first.id);
  useUIStore.getState().setCurrentView('editor');
  return true;
}
