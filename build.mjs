/**
 * Build `client.xterm.js` from `chunk/terminal.js`.
 *
 * React is external (the page's module table provides exactly one copy); xterm, its addon and its
 * stylesheet are bundled in. The result is a self-contained sibling chunk that `client.js` loads
 * on demand through `require.async('./client.xterm.js')`.
 *
 * Run: node build.mjs     (deps: esbuild, @xterm/xterm, @xterm/addon-fit — resolved upward from
 *                          the workspace, nothing is added to this package)
 */

import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const result = await build({
  entryPoints: [join(here, 'chunk/terminal.js')],
  outfile: join(here, 'client.xterm.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  external: ['react'],
  loader: { '.css': 'text' },
  legalComments: 'none',
  minify: true,
  logLevel: 'info',
});

if (result.errors.length > 0) process.exit(1);
console.log('built client.xterm.js');
