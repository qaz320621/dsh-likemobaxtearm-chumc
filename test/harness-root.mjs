/**
 * Locate the DSH installation this package's tests borrow modules from (node-pty, cordis, dsh-tools).
 *
 * The plugin itself has NO dependencies — it never imports a Harness package at runtime. Only these
 * tests do, and they must not hardcode one machine's paths, so the location is resolved here:
 *
 *   1. `DSH_NODE_MODULES` when the caller sets it explicitly;
 *   2. Node's own resolution from the current directory (a normal install / a source checkout);
 *   3. the npx cache (`~/.npm/_npx/<hash>/node_modules`), which is how `npx @deepseek-ai/dsh` runs;
 *   4. the usual global locations.
 *
 * Throws a actionable error when nothing matches.
 */

import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROBE = '@deepseek-ai/dsh-tools/package.json';

function nodeModulesFrom(resolvedProbe) {
  // <root>/node_modules/@deepseek-ai/dsh-tools/package.json → <root>/node_modules
  return dirname(dirname(dirname(resolvedProbe)));
}

function tryResolve(baseDir) {
  try {
    const require = createRequire(join(baseDir, 'noop.js'));
    return nodeModulesFrom(require.resolve(PROBE));
  } catch {
    return null;
  }
}

function tryCandidates() {
  const candidates = [];
  if (process.env.DSH_NODE_MODULES !== undefined && process.env.DSH_NODE_MODULES.length > 0) {
    candidates.push(process.env.DSH_NODE_MODULES);
  }
  candidates.push(process.cwd());

  const npx = join(homedir(), '.npm', '_npx');
  if (existsSync(npx)) {
    for (const entry of readdirSync(npx)) candidates.push(join(npx, entry, 'node_modules'));
  }
  candidates.push(join(homedir(), 'node_modules'), '/usr/local/lib/node_modules', '/usr/lib/node_modules');

  for (const candidate of candidates) {
    if (!existsSync(join(candidate, '@deepseek-ai', 'dsh-tools', 'package.json'))) continue;
    const resolved = tryResolve(candidate) ?? candidate;
    if (existsSync(join(resolved, '@deepseek-ai', 'dsh-tools', 'package.json'))) return resolved;
  }
  return null;
}

let cached = null;

/** @returns {string} the `node_modules` directory that holds the DSH packages. */
export function harnessNodeModules() {
  if (cached !== null) return cached;
  const found = tryCandidates();
  if (found === null) {
    throw new Error(
      'could not find the DSH installation: set DSH_NODE_MODULES to the `node_modules` directory '
      + 'that contains @deepseek-ai/dsh-tools (the tests only need it to borrow node-pty/cordis/dsh-tools)',
    );
  }
  cached = found;
  return found;
}

/** `createRequire` rooted at the DSH installation, for CJS-style package loading. */
export function harnessRequire() {
  return createRequire(join(harnessNodeModules(), 'noop.js'));
}

/** A file:// URL for one file inside the DSH installation, for dynamic `import()`. */
export function harnessUrl(relativePath) {
  return pathToFileURL(join(harnessNodeModules(), relativePath)).href;
}
