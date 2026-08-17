/**
 * Dragging media that is ALREADY on the canvas onto a shot.
 *
 * ── THE GAP THIS CLOSES ──────────────────────────────────────────────────────
 * The board had exactly one way to get media into a shot: drag it out of the
 * asset panel. That is the wrong half of the real workflow. What people actually
 * do is collect first — pull twenty references onto the open canvas, spread them
 * out, compare them, throw half away — and only then decide which one belongs to
 * scene 3. At that point the picture is on the board, three inches from the shot
 * card, and the only way to attach it was to go and find it in the library
 * again.
 *
 * So: drag a canvas image, clip or track onto a shot and it joins that shot,
 * exactly as if it had come from the panel. Drop it on a labelled well and it
 * takes that role.
 *
 * ── WHY AN InteractivityExtension AND NOT A DROP TARGET ──────────────────────
 * `asset-panel.ts` registers a `std.dnd.dropTarget`, and that is right for the
 * panel: a tile is ordinary DOM and its drag is an HTML5 drag. A block already
 * on the canvas is not dragged that way at all — BlockSuite's gfx layer moves it
 * itself, so no drop event is ever fired and `canDrop` never runs. The gfx
 * interactivity API is the only place that sees this gesture.
 *
 * Deliberately does NOT `preventDefault()`: the block should keep moving under
 * the pointer while dragged, because a picture that freezes mid-drag reads as a
 * bug. This only watches, and acts when the gesture ends over a shot.
 */
import {
  InteractivityExtension,
  type DragExtensionInitializeContext,
  type ExtensionDragEndContext,
  type ExtensionDragMoveContext,
} from '@blocksuite/std/gfx';

import { readBlockMeta } from '../board/board-meta';
import { decodeMediaRef } from '../board/media-ref';
import { toast } from '../ui/toast';
import { findBlock } from './blocks';
import { relayOffHostRelease } from './drag-release';
import { dropZoneAt } from './drop';
import { rolesFor, type MediaRole, type ShotMedia } from './model';
import { addMedia, readShot, setMediaRole } from './shots';

/** Media blocks the canvas can hold. Everything else drags as normal. */
const MEDIA_FLAVOURS = new Set(['affine:image', 'affine:attachment']);

/**
 * What a canvas block IS, as a shot would hold it.
 *
 * Both halves matter and they come from different places: `boardMeta` knows the
 * Library identity (id, scope, the full-quality url, the user's name for it) and
 * the media reference knows what the CANVAS was drawing (the display variant and
 * the poster). A shot needs both — `src` for its tile, `url` for the render — so
 * reading only one of them is how a shot ends up with a 4K master in a 104px
 * tile, or with a thumbnail in the finished video.
 */
function mediaOf(
  std: InteractivityExtension['std'],
  id: string,
): Omit<ShotMedia, 'id' | 'role'> | null {
  const block = std.store.getBlock(id);
  if (!block || !MEDIA_FLAVOURS.has(block.flavour)) return null;

  const meta = readBlockMeta(std.store.doc.spaceDoc, id);
  const props = block.model.props as { sourceId?: string; name?: string };
  const ref = props.sourceId ? decodeMediaRef(props.sourceId) : null;

  const kind = meta?.kind ?? ref?.kind;
  if (kind !== 'image' && kind !== 'video' && kind !== 'audio') return null;

  const display = ref?.src ?? meta?.originalUrl;
  if (!display) return null;

  return {
    kind,
    src: display,
    url: meta?.originalUrl || display,
    ...(ref?.poster ? { poster: ref.poster } : {}),
    name: meta?.name || props.name || kind,
    ...(meta?.mediaId ? { mediaId: meta.mediaId } : {}),
    ...(meta?.scope ? { scope: meta.scope } : {}),
  };
}

/** The default role for something dropped in, by kind. Matches `shot/drop.ts` —
 *  `reference` is the safest wrong answer, `sfx` keeps audio out of the score. */
function defaultRole(kind: ShotMedia['kind']): MediaRole {
  return kind === 'audio' ? 'sfx' : 'reference';
}

export class CanvasMediaToShotExtension extends InteractivityExtension {
  static override key = 'voidspace-canvas-media-to-shot';

  /** The shot currently lit up, so exactly one is ever highlighted. */
  private lit: string | null = null;

  private light(shotId: string | null, zone: string | null): void {
    if (this.lit && this.lit !== shotId) {
      (this.std.view.getBlock(this.lit) as { setDropTarget?: (z: string | null) => void } | null)
        ?.setDropTarget?.(null);
    }
    this.lit = shotId;
    if (!shotId) return;
    (this.std.view.getBlock(shotId) as { setDropTarget?: (z: string | null) => void } | null)
      ?.setDropTarget?.(zone);
  }

  override mounted(): void {
    this.action.onDragInitialize((context: DragExtensionInitializeContext) => {
      /**
       * ONE BLOCK ONLY. A marquee of six pictures dragged across a shot is
       * somebody rearranging their board, not somebody filing six references
       * into one scene — and guessing wrong there empties the canvas into a
       * card. Multi-select attach is a deliberate act and belongs on a menu.
       */
      const only = context.elements.length === 1 ? context.elements[0] : null;
      const id = (only as unknown as { id?: string } | null)?.id;
      if (!id || !mediaOf(this.std, id)) return {};

      // Same bridge as the shot reflow uses: a release over the asset panel is
      // a release outside the editor host, and the manager never sees it. See
      // `shot/drag-release.ts`.
      const endRelease = relayOffHostRelease(this.std);

      return {
        onDragMove: (ctx: ExtensionDragMoveContext) => {
          const hit = dropZoneAt(this.std, ctx.event.clientX, ctx.event.clientY);
          this.light(hit?.shotId ?? null, hit?.zone ?? null);
        },

        onDragEnd: (ctx: ExtensionDragEndContext) => {
          this.light(null, null);
          const hit = dropZoneAt(this.std, ctx.event.clientX, ctx.event.clientY);
          if (!hit) return;   // dropped on open canvas — an ordinary move

          const media = mediaOf(this.std, id);
          const shot = readShot(this.std, hit.shotId);
          if (!media || !shot) return;

          /**
           * ATTACH, THEN REMOVE THE CANVAS COPY.
           *
           * A move, not a copy: leaving the picture behind gives the user two of
           * the same thing and no way to tell which one the video will use. The
           * shot's own tile is now where it lives, and one undo puts it back.
           */
          this.std.store.captureSync();
          const mediaId = addMedia(this.std, hit.shotId, {
            ...media,
            role: defaultRole(media.kind),
          });
          if (!mediaId) return;

          // Dropped ON a well — an explicit statement of what it is for. Asked
          // of the SHOT, because a graphic's wells are its block's own slots.
          if (hit.zone) {
            const legal = rolesFor(shot.kind, media.kind, findBlock(shot.composition)?.slots);
            if (legal.includes(hit.zone as MediaRole)) {
              setMediaRole(this.std, hit.shotId, mediaId, hit.zone as MediaRole);
            }
          }

          const block = this.std.store.getBlock(id);
          if (block) this.std.store.deleteBlock(block.model);

          toast(`${media.name} → ${shot.title || 'the shot'}`, 'info');
        },

        clear: () => { endRelease(); this.light(null, null); },
      };
    });
  }

  override unmounted(): void {
    this.light(null, null);
    super.unmounted();
  }
}

/** The payload a drop builds, exposed so a test asserts on the SAME function the
 *  gesture uses rather than on a reimplementation of it. */
export function canvasMediaFor(
  std: InteractivityExtension['std'],
  id: string,
): Omit<ShotMedia, 'id' | 'role'> | null {
  return mediaOf(std, id);
}
