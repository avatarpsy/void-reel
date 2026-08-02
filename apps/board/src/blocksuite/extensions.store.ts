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

// OURS. `voidspace:shot` is the storyboard panel — see shot/model.ts for why a
// custom block is the right call here and what it replaced. It is a plain schema
// extension rather than a provider, so it is appended after the manager's list.
import { shotStoreExtensions } from '../shot/view';

/**
 * NOT REGISTERED, and each for a reason:
 *
 *   database, data-view (kanban)  a storyboard is not a spreadsheet
 *   code, latex, table, callout   document furniture we have no use for
 *   bookmark, embed-doc           link-preview cards; research notes are plain text
 *   embed-youtube/figma/github/loom  third-party embeds we do not want on a canvas
 *   attachment                    file storage; media belongs in the Library
 *   surface-ref, edgeless-text    page↔canvas cross-references; board is edgeless-only
 *
 * If one of these is ever wanted, add its store+view pair above and extend
 * `contract.test.ts`. Do not reach for `getInternalViewExtensions()`.
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
];

/** Schemas — used to build the `Store` a board's Y.Doc is read through. */
export function boardStoreExtensions(): ExtensionType[] {
  return [
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...new StoreExtensionManager(STORE_PROVIDERS as any).get('store'),
    ...shotStoreExtensions,
  ];
}
