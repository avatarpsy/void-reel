import { readFile, writeFile } from 'node:fs/promises';
const source = new URL('../../Voidspace-Website/main/shared/collaboration/changes.ts', import.meta.url);
const target = new URL('../packages/asset-browser/src/collaboration/changes.generated.ts', import.meta.url);
const content = await readFile(source, 'utf8');
await writeFile(target, content);
