/**
 * The SCHEMA half of the allowlist — which block types may EXIST in a board.
 *
 * Split from the view half on purpose. BlockSuite's view modules pull in Lit
 * components and vanilla-extract `.css.ts` stylesheets; the store modules are
 * pure data. Keeping them apart means anything that only reads or writes a
 * board — the contract test, a headless compile, a future server-side
 * screenplay export — never loads a byte of rendering code.
 *
 * See `extensions.view.ts` for the rendering half and the rationale for the
 * allowlist itself.
 */
import { StoreExtensionManager } from '@blocksuite/affine/ext-loader';
import type { ExtensionType } from '@blocksuite/store';

import { FoundationStoreExtension } from '@blocksuite/affine/foundation/store';
import { InlinePresetStoreExtension } from '@blocksuite/affine/inlines/preset/store';
// THE INLINE SPECS ARE NOT OPTIONAL — registering the preset alone is not enough.
// `DefaultInlineManager` resolves every inline spec by identifier at construction
// time; one missing member and the whole manager fails with
//   "Missing dependency [AffineInlineSpec](latex) in creating service
//    [AffineInlineManager](DefaultInlineManager)"
// …repeated once per attempt. The visible symptom is that TEXT DOES NOT WORK
// ANYWHERE — notes, shot titles, edgeless text all refuse to accept input — with
// nothing in the UI explaining why. The block schemas were all fine; rich text
// simply had no manager to run in.
import { LatexStoreExtension } from '@blocksuite/affine/inlines/latex/store';
import { LinkStoreExtension } from '@blocksuite/affine/inlines/link/store';
import { ReferenceStoreExtension } from '@blocksuite/affine/inlines/reference/store';
import { FootnoteStoreExtension } from '@blocksuite/affine/inlines/footnote/store';
import { RootStoreExtension } from '@blocksuite/affine/blocks/root/store';
import { NoteStoreExtension } from '@blocksuite/affine/blocks/note/store';
import { ParagraphStoreExtension } from '@blocksuite/affine/blocks/paragraph/store';
import { ListStoreExtension } from '@blocksuite/affine/blocks/list/store';
import { SurfaceStoreExtension } from '@blocksuite/affine/blocks/surface/store';
import { FrameStoreExtension } from '@blocksuite/affine/blocks/frame/store';
import { AttachmentStoreExtension } from '@blocksuite/affine/blocks/attachment/store';
import { ImageStoreExtension } from '@blocksuite/affine/blocks/image/store';
import { EmbedStoreExtension } from '@blocksuite/affine/blocks/embed/store';
import { ShapeStoreExtension } from '@blocksuite/affine/gfx/shape/store';
import { ConnectorStoreExtension } from '@blocksuite/affine/gfx/connector/store';
import { TextStoreExtension } from '@blocksuite/affine/gfx/text/store';
import { GroupStoreExtension } from '@blocksuite/affine/gfx/group/store';
import { BrushStoreExtension } from '@blocksuite/affine/gfx/brush/store';
import { MindmapStoreExtension } from '@blocksuite/affine/gfx/mindmap/store';
// Free text on the canvas — the schema half of EdgelessTextViewExtension.
import { EdgelessTextStoreExtension } from '@blocksuite/affine/blocks/edgeless-text/store';

/**
 * ── THE BRAINSTORMING SET ────────────────────────────────────────────────────
 * A note used to accept paragraphs and lists and nothing else, which quietly
 * decided what a board was FOR. Working out what to make involves comparing
 * options, quoting a source, pasting a snippet and separating one train of
 * thought from the next — and a surface that cannot do those sends the user
 * somewhere else to do the actual thinking.
 *
 * Each of these is a note CHILD, so none of them changes the canvas model.
 *
 *   bookmark  a web page as a card. Also THE FIX for a broken tool: the Link
 *             button has been on the toolbar all along, and it calls
 *             `insertLinkByQuickSearchCommand` from `affine-block-bookmark` —
 *             which was not registered, so clicking Link and pasting a URL did
 *             nothing at all, silently. It is also how a reference that lives on
 *             the web gets onto the board without being downloaded first.
 *   divider   a rule between sections of a long note.
 *   callout   an aside that has to stand out — a warning, a decision, a caveat.
 *   table     a comparison. The one thing bullets genuinely cannot do, and the
 *             reason `database` (a kanban/spreadsheet view) is still refused:
 *             this is a table in a note, not a second data model.
 */
import { BookmarkStoreExtension } from '@blocksuite/affine/blocks/bookmark/store';
import { DividerStoreExtension } from '@blocksuite/affine/blocks/divider/store';
import { CalloutStoreExtension } from '@blocksuite/affine/blocks/callout/store';
import { TableStoreExtension } from '@blocksuite/affine/blocks/table/store';

// OURS. `voidspace:shot` is the storyboard panel — see shot/model.ts for why a
// custom block is the right call here and what it replaced. It is a plain schema
// extension rather than a provider, so it is appended after the manager's list.
import { shotStoreExtensions } from '../shot/view';

/**
 * STILL NOT REGISTERED, and each for a reason that is about this product rather
 * than about effort:
 *
 *   database, data-view (kanban)  a second data model with its own views, its own
 *                                 columns and its own persistence. `table` above
 *                                 covers the actual need (comparing options) at a
 *                                 fraction of the surface area.
 *   embed-doc, linked-doc         cross-document references. A board is ONE
 *                                 document, so every link would resolve to nothing.
 *   surface-ref                   page↔canvas references; the board is edgeless-only
 *                                 and deliberately has no page mode (see
 *                                 `boardViewExtensions`).
 *   latex (block)                 inline latex is registered and covers a formula in
 *                                 a sentence; a display-maths block is furniture for
 *                                 a paper, not a storyboard.
 *   embed-youtube/figma/github/loom  registered as a SIDE EFFECT of the embed
 *                                 umbrella (see contract.test.ts) but absent from
 *                                 every toolbar and from every agent tool.
 *   code                          MEASURED AND REFUSED, not overlooked. It was
 *                                 registered, and `affine-block-code` imports
 *                                 `shiki` + `shiki/wasm` for highlighting — the
 *                                 same package `src/shims/shiki.ts` exists to keep
 *                                 OUT, because it ships every language grammar as
 *                                 a dynamic import: ~10 MB across ~300 chunks, all
 *                                 of which land in `main/public/board` and in the
 *                                 Nuxt build's scan. The alternative — extending
 *                                 the shim over `createHighlighterCore`,
 *                                 `createOnigurumaEngine`, `bundledLanguagesInfo`
 *                                 and the wasm — ships a code block that never
 *                                 highlights and whose language picker is empty.
 *                                 A monospace paragraph is a better snippet than
 *                                 either. Revisit only if shiki gains a
 *                                 grammar-on-demand entry point.
 *
 * If one of these is ever wanted, add its store+view pair above and extend
 * `contract.test.ts` in the same commit. Do not reach for
 * `getInternalViewExtensions()`.
 */

const STORE_PROVIDERS = [
  FoundationStoreExtension,
  InlinePresetStoreExtension,
  LatexStoreExtension,
  LinkStoreExtension,
  ReferenceStoreExtension,
  FootnoteStoreExtension,
  RootStoreExtension,
  NoteStoreExtension,
  ParagraphStoreExtension,
  ListStoreExtension,
  SurfaceStoreExtension,
  FrameStoreExtension,
  ImageStoreExtension,
  // Video and audio on the canvas. `affine:attachment` is AFFiNE's media block
  // and it ships real players — see the view extension note.
  AttachmentStoreExtension,
  EmbedStoreExtension,
  ShapeStoreExtension,
  ConnectorStoreExtension,
  TextStoreExtension,
  GroupStoreExtension,
  BrushStoreExtension,
  MindmapStoreExtension,
  EdgelessTextStoreExtension,
  // Note content — see the brainstorming-set note above.
  BookmarkStoreExtension,
  DividerStoreExtension,
  CalloutStoreExtension,
  TableStoreExtension,
];

/** Schemas — used to build the `Store` a board's Y.Doc is read through. */
export function boardStoreExtensions(): ExtensionType[] {
  return [
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...new StoreExtensionManager(STORE_PROVIDERS as any).get('store'),
    ...shotStoreExtensions,
  ];
}
