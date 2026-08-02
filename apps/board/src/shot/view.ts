/**
 * Registering `voidspace:shot` and `voidspace:screenplay` with BlockSuite.
 *
 * Two halves, and they must both be present or the failure is silent in a
 * confusing way: the SCHEMA half lets the block exist in the document, the VIEW
 * half lets it paint. A block registered in one and not the other is either an
 * invisible object in the tree or a schema error swallowed at `addBlock` that
 * returns an id resolving to `undefined`.
 *
 * `effect()` is where the custom element is defined — BlockSuite calls it once
 * while building the view extensions. Defining the element at module scope
 * instead would throw `NotSupportedError: the name has already been used` on a
 * remount, which is exactly how the editor died the first time this app tried to
 * call `effects()` by hand.
 */
import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from '@blocksuite/affine-ext-loader';
import { SurfaceBlockSchema } from '@blocksuite/affine/blocks/surface';
import { BlockViewExtension } from '@blocksuite/std';
import { BlockSchemaIdentifier, type BlockSchemaType, type ExtensionType } from '@blocksuite/store';
import { literal } from 'lit/static-html.js';

import { ShotBlockSchemaExtension } from './model';
import { ScreenplayBlockSchemaExtension } from './screenplay-doc';
import { ScreenplayBlockComponent } from './screenplay-block';
import { DraftBlockSchemaExtension } from './draft-block';
import { DraftBlockComponent } from './draft-card';
import { ShotBlockComponent } from './shot-block';

/**
 * TEACH THE SURFACE WHICH OF OUR BLOCKS MAY LIVE ON IT.
 *
 * `affine:surface` declares a CLOSED `children` allowlist — frame, image,
 * bookmark, attachment, `affine:embed-*`, edgeless-text — and schema validation
 * checks the parent's list as well as the child's `parent`. Declaring
 * `parent: ['affine:surface']` on our side is therefore not enough: `addBlock`
 * throws `Block cannot have parent: affine:surface`, inside the Yjs transaction,
 * where it surfaces as a console error and an id that resolves to nothing. Every
 * shot would silently fail to exist.
 *
 * So the surface schema is re-registered with one flavour appended. `override`
 * rather than `addImpl` because the DI container throws on a duplicate
 * identifier — this is the supported way to replace a registered service, and
 * everything else about the surface is untouched (same version, same props, same
 * transformer), so documents stay byte-compatible in both directions.
 *
 * The alternative was naming the block `affine:embed-shot` to slip through the
 * wildcard. That would have worked and it would have been a lie: it is not an
 * AFFiNE embed, and the next person to read the schema would have believed it.
 */
const SurfaceWithShots: BlockSchemaType = {
  ...SurfaceBlockSchema,
  model: {
    ...SurfaceBlockSchema.model,
    children: [
      ...(SurfaceBlockSchema.model.children ?? []),
      'voidspace:shot',
      // The screenplay is a block on the board for the same reason a shot is:
      // it is a thing the user reads, selects, moves and types into. Adding it
      // here is what makes `addBlock` legal — omitted, the block would be
      // rejected inside the Yjs transaction and simply never appear.
      'voidspace:screenplay',
      // The scratch pad: a designed block being previewed before it is saved.
      'voidspace:blockdraft',
    ],
  },
};

const SurfaceWithShotsExtension: ExtensionType = {
  setup: di => {
    di.override(BlockSchemaIdentifier('affine:surface'), () => SurfaceWithShots);
  },
};

/** Schema only — safe to import from a headless context (tests, compile). */
export const shotStoreExtensions: ExtensionType[] = [
  ShotBlockSchemaExtension,
  ScreenplayBlockSchemaExtension,
  DraftBlockSchemaExtension,
  // AFTER the surface's own registration — see above.
  SurfaceWithShotsExtension,
];

export class ShotViewExtension extends ViewExtensionProvider {
  override name = 'voidspace-shot';

  override effect(): void {
    super.effect();
    if (!customElements.get('voidspace-shot')) {
      customElements.define('voidspace-shot', ShotBlockComponent);
    }
    if (!customElements.get('voidspace-screenplay')) {
      customElements.define('voidspace-screenplay', ScreenplayBlockComponent);
    }
    if (!customElements.get('voidspace-blockdraft')) {
      customElements.define('voidspace-blockdraft', DraftBlockComponent);
    }
  }

  override setup(context: ViewExtensionContext): void {
    super.setup(context);
    context.register(BlockViewExtension('voidspace:shot', literal`voidspace-shot`));
    context.register(
      BlockViewExtension('voidspace:screenplay', literal`voidspace-screenplay`),
    );
    context.register(
      BlockViewExtension('voidspace:blockdraft', literal`voidspace-blockdraft`),
    );
  }
}
