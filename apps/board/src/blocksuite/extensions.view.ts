/**
 * The RENDERING half of the allowlist — how the permitted blocks are drawn.
 *
 * Pairs 1:1 with `extensions.store.ts`; a block registered there but not here
 * exists in the document and paints nothing. Importing this module pulls in Lit
 * and vanilla-extract stylesheets, so only the browser entry should touch it.
 */
import { ViewExtensionManager } from '@blocksuite/affine/ext-loader';
import type { ExtensionType } from '@blocksuite/store';

import { FoundationViewExtension } from '@blocksuite/affine/foundation/view';
import { InlinePresetViewExtension } from '@blocksuite/affine/inlines/preset/view';
// Paired with the store halves — see the note in extensions.store.ts. Without
// these the inline manager cannot be built and no text is editable anywhere.
import { LatexViewExtension } from '@blocksuite/affine/inlines/latex/view';
import { LinkViewExtension as InlineLinkViewExtension } from '@blocksuite/affine/inlines/link/view';
import { ReferenceViewExtension } from '@blocksuite/affine/inlines/reference/view';
import { FootnoteViewExtension } from '@blocksuite/affine/inlines/footnote/view';
import { MentionViewExtension } from '@blocksuite/affine/inlines/mention/view';
import { RootViewExtension } from '@blocksuite/affine/blocks/root/view';
import { NoteViewExtension } from '@blocksuite/affine/blocks/note/view';
import { ParagraphViewExtension } from '@blocksuite/affine/blocks/paragraph/view';
import { ListViewExtension } from '@blocksuite/affine/blocks/list/view';
import { SurfaceViewExtension } from '@blocksuite/affine/blocks/surface/view';
import { FrameViewExtension } from '@blocksuite/affine/blocks/frame/view';
import { AttachmentViewExtension } from '@blocksuite/affine/blocks/attachment/view';

import { VoidspaceMediaViewExtension } from '../board/media-embed';
// OURS. The storyboard panel — a real block that owns its media, which is what
// removed the frame-membership reconciler that used to live here. AFFiNE adds an
// element to the frame it is dropped on but never removes it from the one it came
// from, so a picture moved between shots was claimed by both; a shot's media are
// now props, so there is no membership to reconcile.
import { ShotViewExtension } from '../shot/view';
// Dragging media that is already ON the canvas into a shot. Registered as a gfx
// INTERACTIVITY extension rather than a drop target: a block on the canvas is
// moved by BlockSuite's own gfx layer, so no HTML5 drop event is ever fired and
// the panel's `std.dnd.dropTarget` never sees the gesture. See canvas-drop.ts.
import { CanvasMediaToShotExtension } from '../shot/canvas-drop';
import { ImageViewExtension } from '@blocksuite/affine/blocks/image/view';
import { EmbedViewExtension } from '@blocksuite/affine/blocks/embed/view';
import { ShapeViewExtension } from '@blocksuite/affine/gfx/shape/view';
import { ConnectorViewExtension } from '@blocksuite/affine/gfx/connector/view';
import { TextViewExtension } from '@blocksuite/affine/gfx/text/view';
import { GroupViewExtension } from '@blocksuite/affine/gfx/group/view';
import { BrushViewExtension } from '@blocksuite/affine/gfx/brush/view';
import { MindmapViewExtension } from '@blocksuite/affine/gfx/mindmap/view';
// THE SELECT TOOL. Without `pointer` the toolbar has no way back to "select" —
// after drawing a shape you stay in shape mode, which is why the canvas felt
// like it was fighting you. It contributes the `default` tool, i.e. the arrow.
import { PointerViewExtension } from '@blocksuite/affine/gfx/pointer/view';
// The "Link" tool — paste a URL onto the canvas as a card. This is the native
// path a user reaches for when pulling a reference off the web.
import { LinkViewExtension } from '@blocksuite/affine/gfx/link/view';

// ── The NATIVE canvas ───────────────────────────────────────────────────────
// Registering AFFiNE's own toolbar rather than hand-building one. It is the
// single biggest thing that makes this feel like a canvas instead of a viewer:
// each block/gfx package we already register CONTRIBUTES its tool to it, so
// this one line yields pen, shapes, text, sticky notes, images (with drag-drop
// and upload), connectors, frames and mindmaps — all of them tools an artist
// expects to find, none of them ours to maintain.
//
// `EdgelessSelectedRect` is not optional alongside it: without selection
// handles you cannot move, resize or rotate anything you just made, which makes
// every tool above feel broken. It has no umbrella export, so it comes from its
// own package.
import { EdgelessToolbarViewExtension } from '@blocksuite/affine/widgets/edgeless-toolbar/view';
import { EdgelessSelectedRectViewExtension } from '@blocksuite/affine-widget-edgeless-selected-rect/view';
// The contextual toolbar that appears above a SELECTION (colour, style, delete).
import { ToolbarViewExtension } from '@blocksuite/affine/widgets/toolbar/view';
// Native zoom control (bottom-left). Registering theirs means our own chrome
// carries only what is genuinely storyboard-specific.
import { EdgelessZoomToolbarViewExtension } from '@blocksuite/affine-widget-edgeless-zoom-toolbar/view';
// Free text placed directly on the canvas — labels, arrows' captions, the notes
// an artist scribbles beside a shot rather than inside it.
import { EdgelessTextViewExtension } from '@blocksuite/affine/blocks/edgeless-text/view';
// Edgeless-specific note behaviour (a sticky note on the canvas).
import { NoteViewExtension as GfxNoteViewExtension } from '@blocksuite/affine/gfx/note/view';

// ── The brainstorming set ───────────────────────────────────────────────────
// Paired with the store halves — see the long note in extensions.store.ts for
// what each one is for and why database/linked-doc are still refused.
//
// BOOKMARK IS A BUG FIX, not only a feature. `LinkViewExtension` (below) puts a
// "Link" button on the native toolbar, and its handler runs
// `insertLinkByQuickSearchCommand` from `affine-block-bookmark`. That block was
// never registered, so the schema rejected it: the button was there, the paste
// dialog opened, and nothing was ever created. Silently — the failure is a
// schema warning in the console and an id that resolves to undefined.
import { BookmarkViewExtension } from '@blocksuite/affine/blocks/bookmark/view';
import { DividerViewExtension } from '@blocksuite/affine/blocks/divider/view';
import { CalloutViewExtension } from '@blocksuite/affine/blocks/callout/view';
import { TableViewExtension } from '@blocksuite/affine/blocks/table/view';

/**
 * THE SLASH MENU — how anyone finds any of the above.
 *
 * Every block package contributes its own entry (`SlashMenuConfigExtension`,
 * which is why `AttachmentViewExtension` and the rest already register one), so
 * this single line turns the whole registered set into something discoverable by
 * typing `/` in a note. Without it, headings, lists, code, tables, dividers and
 * callouts are all present in the schema and reachable only by someone who
 * already knows the markdown shortcut.
 *
 * It was previously listed as "deliberately NOT registered". That was the right
 * call when a note could hold paragraphs and lists and nothing else — a menu of
 * two items is noise. It is the wrong call now that there is a set worth
 * browsing.
 */
import { SlashMenuViewExtension } from '@blocksuite/affine/widgets/slash-menu/view';

// ── Edgeless widgets ────────────────────────────────────────────────────────
// NOT optional. Blocks and gfx elements alone give you a document that is
// CORRECT and INVISIBLE: frames created via the store were present in the tree
// and the viewport fit to their bounds, but painted nothing, because a frame
// defaults to `background: transparent` and its label is drawn by the
// frame-title WIDGET. Selection handles and marquee are widgets too, so without
// these a shot cannot be seen, selected, moved or resized.
import { FrameTitleViewExtension } from '@blocksuite/affine/widgets/frame-title/view';
import { EdgelessDraggingAreaViewExtension } from '@blocksuite/affine/widgets/edgeless-dragging-area/view';
// SELECTION AFFORDANCES. Without these a block can be selected in the model but
// gives the user almost no feedback, which reads as "clicking doesn't work":
//   drag-handle      — the hover grip that makes a block obviously grabbable
//   viewport-overlay — the overlay layer hit-testing and hover states draw into
//   auto-connect     — connector anchor points on hover
import { DragHandleViewExtension } from '@blocksuite/affine/widgets/drag-handle/view';
import { ViewportOverlayViewExtension } from '@blocksuite/affine/widgets/viewport-overlay/view';
import { EdgelessAutoConnectViewExtension } from '@blocksuite/affine/widgets/edgeless-auto-connect/view';
// Still NOT registered: linked-doc (a board is one document, so every link would
// resolve to nothing), scroll-anchoring and page-dragging-area (page-mode
// widgets; the board is edgeless-only), remote-selection (no multiplayer cursors
// yet — the board syncs whole snapshots, not awareness).

const VIEW_PROVIDERS = [
  FoundationViewExtension,
  InlinePresetViewExtension,
  LatexViewExtension,
  InlineLinkViewExtension,
  ReferenceViewExtension,
  FootnoteViewExtension,
  MentionViewExtension,
  RootViewExtension,
  NoteViewExtension,
  ParagraphViewExtension,
  ListViewExtension,
  SurfaceViewExtension,
  FrameViewExtension,
  ImageViewExtension,
  /**
   * Video and audio, natively.
   *
   * `affine-block-attachment/src/embed.ts` ships embed configs for image, pdf,
   * VIDEO and AUDIO — the video one renders `<video ... controls>` and the audio
   * one `<audio controls>`, and `BlockViewExtension` maps a surface-parented
   * attachment to `affine-edgeless-attachment`. This block was simply never
   * registered, which is why board media was a labelled rectangle with no play
   * button: the player existed the whole time and we were not asking for it.
   */
  AttachmentViewExtension,
  // MUST come after it: overrides the video/audio embed configs that extension
  // registers, so the player letterboxes instead of cropping. See media-embed.ts.
  VoidspaceMediaViewExtension,
  ShotViewExtension,
  EmbedViewExtension,
  ShapeViewExtension,
  ConnectorViewExtension,
  TextViewExtension,
  GroupViewExtension,
  BrushViewExtension,
  MindmapViewExtension,
  PointerViewExtension,
  LinkViewExtension,
  FrameTitleViewExtension,
  EdgelessDraggingAreaViewExtension,
  DragHandleViewExtension,
  ViewportOverlayViewExtension,
  EdgelessAutoConnectViewExtension,
  EdgelessToolbarViewExtension,
  EdgelessSelectedRectViewExtension,
  ToolbarViewExtension,
  EdgelessZoomToolbarViewExtension,
  EdgelessTextViewExtension,
  GfxNoteViewExtension,
  // The brainstorming set, and the menu that makes it findable.
  BookmarkViewExtension,
  DividerViewExtension,
  CalloutViewExtension,
  TableViewExtension,
  SlashMenuViewExtension,
];

/**
 * Rendering — always the `edgeless` scope.
 *
 * A board has no page mode. BlockSuite documents are isomorphic (the same tree
 * renders as a document or a canvas), which is worth keeping in reserve for a
 * future "read the screenplay as a document" view — but exposing a mode switch
 * now would let a user drag the board into a shape the compiler has no meaning
 * for. One surface, one meaning.
 */
export function boardViewExtensions(): ExtensionType[] {
  return [
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...new ViewExtensionManager(VIEW_PROVIDERS as any).get('edgeless'),
    // OURS, appended: a plain extension rather than a provider, same as the
    // shot block's schema half.
    CanvasMediaToShotExtension,
  ];
}
