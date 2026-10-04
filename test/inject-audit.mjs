/**
 * Static inject audit.
 *
 * Cordis refuses `ctx.<service>` access unless the calling fiber declared that service in `inject`
 * ("cannot get property X without inject"), and one such miss takes the whole plugin down at boot.
 * This test reads both halves' real sources, extracts every `ctx.<prop>` access, and proves each
 * one is either a Cordis core member or declared in that half's inject list.
 *
 * Run: node test/inject-audit.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, '..');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`);
}

/** Cordis context members that are not services and never need an inject declaration. */
const CORE_MEMBERS = new Set([
  'effect', 'on', 'logger', 'inject', 'get', 'set', 'provide', 'emit', 'parallel', 'bail',
  'scope', 'isolate', 'reflect', 'registry', 'root', 'fiber', 'start', 'stop', 'waterfall',
]);

function collectCtxAccesses(sources) {
  const found = new Map();
  for (const { file, text } of sources) {
    for (const match of text.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) {
      const prop = match[1];
      if (!found.has(prop)) found.set(prop, new Set());
      found.get(prop).add(file);
    }
  }
  return found;
}

function readSources(files) {
  return files.map((file) => ({ file, text: readFileSync(file, 'utf8') }));
}

function audit(label, sources, declared) {
  const accesses = collectCtxAccesses(sources);
  const undeclared = [...accesses.entries()]
    .filter(([prop]) => !CORE_MEMBERS.has(prop) && !declared.includes(prop))
    .map(([prop, files]) => `${prop} (${[...files].join(', ')})`);
  check(
    `${label}: every ctx.<service> access is declared`,
    undeclared.length === 0,
    undeclared.length === 0
      ? `${[...accesses.keys()].filter((prop) => !CORE_MEMBERS.has(prop)).sort().join(', ')} ⊆ inject`
      : `missing from inject: ${undeclared.join('; ')}`,
  );
  return accesses;
}

// ---- host half
const hostModule = await import('../index.js');
const hostFiles = [join(packageDir, 'index.js'), ...readdirSync(join(packageDir, 'src')).map((name) => join(packageDir, 'src', name))];
const hostAccesses = audit('host', readSources(hostFiles), hostModule.inject ?? []);

const clientSource = readFileSync(join(packageDir, 'client.js'), 'utf8');

// `webServer` stays OUT: the only API that needed it (`connection.rpc.handle`) is consumer-broken,
// so the plugin must never depend on it.
check('host does not declare webServer (we avoid the consumer-broken rpc.handle)', !(hostModule.inject ?? []).includes('webServer'), JSON.stringify(hostModule.inject));

/** Strip comments so prose about a forbidden API cannot count as a use of it. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const hostCode = stripComments(hostFiles.map((file) => readFileSync(file, 'utf8')).join('\n'));
const clientCode = stripComments(clientSource);
check('host code never calls connection.rpc.handle', !/\.rpc\.handle\s*\(/.test(hostCode));
check('host code never reads ctx.webServer', !/ctx\.webServer\b/.test(hostCode));
check('client code never calls connection.rpc.call', !/\.rpc\.call\s*\(/.test(clientCode));
check('the scanner would catch a reintroduced call', /\.rpc\.handle\s*\(/.test('ctx.connection.rpc.handle(x)'));
check('host declares every service it touches', (hostModule.inject ?? []).includes('connection') && (hostModule.inject ?? []).includes('tools') && (hostModule.inject ?? []).includes('systemPrompt') && (hostModule.inject ?? []).includes('subprocess') && (hostModule.inject ?? []).includes('agents'));
check('host never touches connections through a different name', !hostAccesses.has('clientModules') && !hostAccesses.has('sessions'));

// A Linux-only absolute default would break macOS/Windows installs out of the box.
{
  const { DEFAULTS } = await import('../index.js');
  check('the default ssh binary is a portable PATH lookup', DEFAULTS.sshBinary === 'ssh' && !DEFAULTS.sshBinary.includes('/'), DEFAULTS.sshBinary);
}

// ---- client half (registered through the module loader; the factory only runs registration code)
let plugin = null;
globalThis.window = {
  __ModuleLoader__: { load: (registration) => { globalThis.window.__registration = registration; } },
  addEventListener: () => {},
  removeEventListener: () => {},
};
new Function('window', clientSource)(globalThis.window);
const fakeReact = {
  createElement: () => null,
  Fragment: 'Fragment',
  Suspense: 'Suspense',
  lazy: (loader) => ({ loader }),
  Component: class Component {},
  useState: () => [null, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useSyncExternalStore: () => 0,
};
const fakeRequire = Object.assign((name) => {
  if (name === 'react') return fakeReact;
  throw new Error(`unexpected module: ${name}`);
}, { async: async () => ({ createSshTerminal: () => () => null }) });
plugin = globalThis.window.__registration.factory(fakeRequire);
check('client half can be loaded and its factory executed', plugin !== null && Array.isArray(plugin.inject));
audit('client', [{ file: join(packageDir, 'client.js'), text: clientSource }], plugin.inject ?? []);

// Self-test: an undeclared service access must still be caught by this audit.
{
  const accesses = collectCtxAccesses([{ file: 'synthetic', text: 'ctx.mysteryService.doThing();' }]);
  const undeclared = [...accesses.keys()].filter((prop) => !CORE_MEMBERS.has(prop) && !(hostModule.inject ?? []).includes(prop));
  check('audit still rejects an undeclared service access (regression guard)', undeclared.includes('mysteryService'), `would report: ${undeclared.join(', ')}`);
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
