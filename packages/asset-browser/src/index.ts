/**
 * @openreel/asset-browser — the pluggable asset browser core.
 *
 * Framework-agnostic on purpose: the video editor renders it with React, the
 * board with plain DOM, and neither owns it. See `types.ts` for why the JSX was
 * deliberately NOT extracted along with the data layer.
 *
 * `panel-chrome` is here for the same reason and is NOT asset-specific: it is
 * how EVERY side panel in every editor opens and closes, and the board needs it
 * without React. See its header.
 */
export * from './types';
export * from './sources';
export * from './cache';
export * from './thumbs';
export * from './view-model';
export * from './panel-chrome';
export * from './blocks';
/**
 * The LIVE block preview — the renderer, its runtime shim and the visibility
 * scheduler that decides which of 128 tiles may actually run.
 *
 * It lived in the board until the video editor needed the same thing. A block is
 * layout, typography AND MOTION, and zero previews exist on disk, so the honest
 * thumbnail is to run the block — which is a whole sandboxed-iframe, CSP and
 * budget problem that nobody should solve twice.
 */
export * from './block-preview/auth';
export * from './block-preview/block-preview';
