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
