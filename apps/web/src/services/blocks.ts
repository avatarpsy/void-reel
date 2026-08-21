/**
 * The block library, as the VIDEO EDITOR reaches it.
 *
 * Almost nothing left here on purpose: the fetch, the normalisation, the cache
 * and the "why is it empty" sentence are all shared
 * (`@openreel/asset-browser`), because the board and the image editor browse the
 * same library and three copies of that logic is three chances for one surface
 * to parse a block's slots differently from another.
 *
 * What stays local is the one thing the package cannot know — where this app's
 * credentials are. That is registered in `main.tsx`, before React mounts.
 */
export {
  loadBlockCatalogue as loadBlocks,
  refreshBlockCatalogue as refreshBlocks,
  cachedBlockCatalogue as cachedBlocks,
  blockCatalogueError as blockLoadError,
  type BlockInfo,
} from "@openreel/asset-browser";

import { loadBlockCatalogue } from "@openreel/asset-browser";
import type { BlockInfo } from "@openreel/asset-browser";

/** One block by name, from the catalogue (fetching it if needed). */
export async function findBlock(name: string): Promise<BlockInfo | null> {
  const all = await loadBlockCatalogue();
  return all.find((b) => b.name === name) ?? null;
}
