// project-cloud-open.ts
// -----------------------------------------------------------------------------
// Reopening an image-editor project, in the order that loses the least.
//
//   1. THE STORED DOCUMENT   the real layered project, from Cloud Storage.
//                            Works on any device, restores exactly what was
//                            saved. This is the normal path.
//   2. THE FLATTENED PAGES   one image layer per page, rebuilt from the listing
//                            thumbnails. Only for projects made before documents
//                            were stored, where no file exists to fetch.
//
// The fallback is kept because those projects are real and someone still wants
// them; it is not the design, it is the tail. A project opened that way says so,
// so nobody believes they have their layer tree back when they do not.
// -----------------------------------------------------------------------------

import { getVoidspaceIdToken } from './voidspace-storage';
import type { Project } from '../types/project';
import { useProjectStore } from '../stores/project-store';
import { useUIStore } from '../stores/ui-store';
import { aspectRatioToSize } from './image-generation';
import type { MediaAsset } from '../types/project';
import { setCloudSaveStatus } from './project-cloud-status';

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
 * Load the REAL stored document for a project, if there is one.
 *
 * Returns null when the project predates document storage — the caller then
 * falls back to the flattened rebuild, which is the old behaviour, so nothing
 * regresses for those.
 */
export async function loadProjectDocument(projectId: string): Promise<Project | null> {
  const token = await getVoidspaceIdToken();
  if (!token) return null;
  try {
    const res = await fetch(
      `/api/studio/image-doc?project=${encodeURIComponent(projectId)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('The editable project could not be loaded from your account. Check your connection and sign in, then retry.');
    const doc = await res.json();
    // A document with no artboards is not openable and would replace the user's
    // canvas with nothing — treat it as absent rather than as valid.
    if (!doc || !Array.isArray(doc.artboards) || !doc.artboards.length) throw new Error('The stored project could not be read. Retry before opening a flattened copy.');
    return doc as Project;
  } catch (error) {
    // A failed network/auth read is not evidence that the layered document is
    // absent. Never replace it with a flattened thumbnail after a transient miss.
    throw error instanceof Error ? error : new Error('The editable project could not be loaded. Retry when connected.');
  }
}

/**
 * Open the cloud project <id> as a flattened multi-page editor project (page N =
 * one full-bleed image layer). Returns false if it isn't found. Switches to the
 * editor when at least one page loads.
 */
export async function openCloudImageProject(id: string, knownDocument?: Project | null): Promise<boolean> {
  const token = await getVoidspaceIdToken();
  if (!token) return false;

  /**
   * THE REAL DOCUMENT FIRST.
   *
   * When one exists this returns the project exactly as it was saved — every
   * layer, on any device. The flattened rebuild below only runs for projects
   * made before documents were stored, where there is genuinely nothing else to
   * open.
   */
  const doc = knownDocument === undefined ? await loadProjectDocument(id) : knownDocument;
  if (doc) {
    useProjectStore.getState().loadProject(doc);
    // NOT flattened — this is the real layer tree. Cleared explicitly so the
    // flag from a previously opened flattened project cannot leak onto this
    // one and make the agent apologise for limits that do not apply.
    useUIStore.getState().setFlattenedProjectId(null);
    useUIStore.getState().setCurrentView('editor');
    return true;
  }

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
    // Register + place as ONE undo step: undoing a page must not leave its
    // asset orphaned in the Assets panel.
    useProjectStore.getState().runTransaction(`Open page ${i + 1}`, () => {
      useProjectStore.getState().addAsset(asset);
      useProjectStore.getState().addImageLayer(asset.id, { x: 0, y: 0, width: size.width, height: size.height });
    });
  }

  const first = useProjectStore.getState().project?.artboards[0];
  if (first) P.selectArtboard(first.id);
  // This copy is FLATTENED — one image per page, none of the original layer
  // tree (that lives in the IndexedDB of the browser the project was made on).
  // Flagged by project id so the agent tells the user instead of promising layer
  // edits it cannot make here, and so the flag can't leak onto the next project.
  const openedId = useProjectStore.getState().project?.id ?? null;
  useUIStore.getState().setFlattenedProjectId(openedId);
  useUIStore.getState().setCurrentView('editor');
  return true;
}

/** A cached browser document cannot hide edits saved from another device.
 * Keep the newer draft; an offline cached copy remains usable with a warning. */
export async function openImageProjectWithCache(id: string, local: Project | null): Promise<boolean> {
  let cloud: Project | null;
  try { cloud = await loadProjectDocument(id); }
  catch (error) {
    if (!local) throw error;
    useProjectStore.getState().loadProject(local);
    useUIStore.getState().setFlattenedProjectId(null);
    useUIStore.getState().setCurrentView('editor');
    setCloudSaveStatus(id, { state: 'error', updatedAt: local.updatedAt || 0,
      message: 'Opened the copy on this device. Cloud changes could not be checked. Reconnect and reopen before editing on another device.' });
    return true;
  }
  const document = local && (!cloud || (local.updatedAt || 0) > (cloud.updatedAt || 0)) ? local : cloud;
  return openCloudImageProject(id, document);
}
