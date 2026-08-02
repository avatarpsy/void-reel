#!/usr/bin/env node
/**
 * Typecheck OUR source, not BlockSuite's.
 *
 * WHY THIS SCRIPT EXISTS INSTEAD OF PLAIN `tsc --noEmit`
 * `@blocksuite/*` publishes TypeScript SOURCE — every `exports` entry points at
 * `./src/*.ts` and there is no `types` condition, so TypeScript pulls ~70
 * packages of their source into our program and reports their diagnostics as
 * ours. On 0.22.4 that is ~285 errors: stage-3 decorators, `findLast`,
 * `MapIterator` methods, and implicit anys in code we do not own, cannot patch,
 * and must not silence globally by loosening `strict` for our own files.
 *
 * Mapping `paths` at their `dist/*.d.ts` tree was tried first. It works for the
 * five packages we import directly, then collapses: those declarations re-export
 * ~70 sibling packages that would each need their own mapping, against pnpm's
 * content-addressed layout. Enumerating them is a generated tsconfig that rots
 * on every install.
 *
 * So: run the real compiler, keep every diagnostic that names a file under
 * `src/`, and drop the rest. Our code is checked strictly; theirs is their
 * problem. If BlockSuite ever ships a `types` condition, delete this file and
 * put `tsc --noEmit` back in package.json.
 */
import { spawnSync } from 'node:child_process';

const tsc = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['tsc', '--noEmit', '--pretty', 'false'],
  { encoding: 'utf8', shell: process.platform === 'win32' },
);

const lines = `${tsc.stdout ?? ''}${tsc.stderr ?? ''}`.split(/\r?\n/);

// A diagnostic block is "file(line,col): error TSxxxx: msg" followed by
// optional indented continuation lines. Keep a block only if its header names
// one of our files; carry its continuation lines with it.
const ours = [];
let keeping = false;
for (const line of lines) {
  const header = /^(.+?)\(\d+,\d+\): (error|warning) TS\d+:/.exec(line);
  if (header) {
    const file = header[1].replace(/\\/g, '/');
    keeping = !file.includes('node_modules/');
    if (keeping) ours.push(line);
    continue;
  }
  if (keeping && /^\s/.test(line) && line.trim()) ours.push(line);
}

if (ours.length) {
  console.error(ours.join('\n'));
  console.error(`\n✗ ${ours.filter(l => /error TS\d+:/.test(l)).length} error(s) in src/`);
  process.exit(1);
}

console.log('✓ typecheck clean (src/ only — BlockSuite source diagnostics excluded by design)');
