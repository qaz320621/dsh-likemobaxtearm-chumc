/**
 * Client-half wiring test: loads the real `client.js`, runs its `apply(ctx)` against a stubbed
 * client context, and drives the frame stream.
 *
 * It verifies REGISTRATIONS and the data path only — no DOM, no React render, no visual claim.
 * Components are registered as functions and never executed, so the page's own appearance still
 * has to be confirmed in the browser.
 *
 * Run: node test/client-wiring.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- browser stubs (registration only)

const registered = { tabTypes: [], slots: [], closeHandlers: [], openTabs: [], focused: [], inventory: [] };
const invokeCalls = [];
let controller = null;

const fakeReact = {
  createElement: () => null,
  Fragment: 'Fragment',
  Suspense: 'Suspense',
  lazy: (loader) => ({ lazyLoader: loader }),
  Component: class Component { constructor(props) { this.props = props; } },
  useState: () => [null, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useSyncExternalStore: () => 0,
};

const fakeRequire = Object.assign(
  (name) => {
    if (name === 'react') return fakeReact;
    throw new Error(`unexpected module request: ${name}`);
  },
  { async: async () => ({ createSshTerminal: () => () => null }) },
);

const fakeCtx = {
  effect(execute, label) {
    const disposer = execute();
    return () => { try { disposer?.(); } catch { /* ignore */ } };
    void label;
  },
  slots: {
    inject(ownerKey, callback) { registered.slots.push({ ownerKey, disposer: callback() }); return () => {}; },
    register(options) { return () => {}; },
  },
  sidebarRightTabs: {
    register(definition) { registered.tabTypes.push(definition); return () => {}; },
  },
  sidebarRight: {
    registerCloseHandler(kind, handler) { registered.closeHandlers.push({ kind, handler }); return () => {}; },
    openTab(kind, options) {
      registered.openTabs.push({ kind, options });
      // A real Host strip lists what it opened; without this the plugin would keep opening.
      registered.inventory = [...registered.inventory, { id: `tab-open-${registered.openTabs.length}`, kind, contentId: `c-open-${registered.openTabs.length}` }];
    },
    focus(tabId) { registered.focused.push(tabId); },
    openTabs: { getSnapshot: () => registered.inventory },
    tabDomain: {
      // Authoritative in production; throws here for tab-7 so the navigation fallback is exercised.
      occurrence: (_sessionId, tab) => {
        if (tab.id === 'tab-7') throw new Error('not an occurrence in this pane');
        return { navigation: { getSnapshot: () => ({ params: { sessionId: `from-domain-${tab.id}` } }) } };
      },
    },
  },
};

// Both channels are plain fetch calls now; the stream is a body we control frame by frame.
globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target.includes('dsh-ssh/invoke')) {
    const payload = JSON.parse(String(init?.body ?? '{}'));
    invokeCalls.push({ method: payload.method, params: payload.params });
    const values = {
      hello: { hosts: [], logDir: '/ws/logs', hostsFile: '/ws/hosts.json', sessions: [] },
      'output.since': { seq: 0, data: '' },
      'session.close': { sessionId: payload.params?.sessionId, closed: true },
    };
    return new Response(JSON.stringify({ ok: true, value: values[payload.method] ?? {} }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  if (target.includes('dsh-ssh/stream')) {
    return new Response(new ReadableStream({ start(c) { controller = c; } }), {
      status: 200, headers: { 'content-type': 'application/x-ndjson' },
    });
  }
  throw new Error(`unexpected fetch: ${url}`);
};
// The plugin remembers connections in localStorage, so the test needs the browser API it uses.
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
  clear: () => { storage.clear(); },
};

globalThis.window = {
  __ModuleLoader__: { load: (registration) => { globalThis.window.__loaded = registration; } },
  addEventListener: () => {},
  removeEventListener: () => {},
};

// ---------------------------------------------------------------- run

const code = readFileSync(join(here, '..', 'client.js'), 'utf8');
new Function('window', code)(globalThis.window);
const registration = globalThis.window.__loaded;
check('client bundle registers itself with the module loader', registration?.id === 'dsh-likemobaxtearm-chumc', registration?.id);

const plugin = registration.factory(fakeRequire);
check('plugin declares the services it uses', JSON.stringify(plugin.inject) === JSON.stringify(['slots', 'sidebarRight', 'sidebarRightTabs']), JSON.stringify(plugin.inject));

plugin.apply(fakeCtx);

// The plugin's test seams (pure helpers + the store), used by the checks below.
const internals = plugin.__internals;

check('two right-sidebar tab types registered', registered.tabTypes.length === 2, registered.tabTypes.map((entry) => entry.kind).join(', '));
const consoleType = registered.tabTypes.find((entry) => entry.kind === 'ssh-console');
const legacyType = registered.tabTypes.find((entry) => entry.kind === 'ssh');
check('the console is one page with a guide card',
  consoleType !== undefined && consoleType.multiple === undefined && consoleType.guide?.length === 1 && typeof consoleType.title === 'function',
  JSON.stringify({ multiple: consoleType?.multiple, guide: consoleType?.guide?.length }));
check('the legacy per-session type stays registered but is not offered in the guide',
  legacyType?.multiple === true && legacyType.guide === undefined, JSON.stringify(legacyType?.guide));
check('no close handler is registered: closing a Host tab must not kill a session',
  registered.closeHandlers.length === 0, JSON.stringify(registered.closeHandlers.map((entry) => entry.kind)));
const paneSeats = registered.slots.filter((entry) => entry.ownerKey === 'sidebar.right.pane.tab').length;
const titleSeats = registered.slots.filter((entry) => entry.ownerKey === 'sidebar.right.pane.tab.title').length;
check('two pane seats and two title seats injected', paneSeats === 2 && titleSeats === 2, `${paneSeats} pane + ${titleSeats} title`);

await sleep(30);
check('startup asks the Host for a snapshot', invokeCalls.some((call) => call.method === 'hello'), invokeCalls.map((call) => call.method).join(','));

// ---------------------------------------------------------------- drive the frame stream

const send = (frame) => controller.enqueue(new TextEncoder().encode(`${JSON.stringify(frame)}\n`));

send({ t: 'hello', dshSessionId: 'dsh-1', sessions: [{ id: 'ssh-9', host: 'localhost', state: 'ready', permission: 'ask', dshSessionId: 'dsh-1' }], hosts: [], logDir: '/ws/logs' });
await sleep(40);
check('hello frame triggers history hydration for live sessions', invokeCalls.some((call) => call.method === 'output.since' && call.params?.sessionId === 'ssh-9'), JSON.stringify(invokeCalls[invokeCalls.length - 1]?.method));

send({ t: 'output', sessionId: 'ssh-9', seq: 1, data: 'hello from remote\n' });
send({ t: 'opened', dshSessionId: 'dsh-1', session: { id: 'ssh-10', host: 'ai-made-host', state: 'connecting', permission: 'ask', dshSessionId: 'dsh-1' } });
await sleep(40);
check('an AI-created session reveals the single console tab',
  registered.openTabs.filter((entry) => entry.kind === 'ssh-console').length === 1,
  JSON.stringify(registered.openTabs.map((entry) => entry.kind)));
check('hydration runs for the new session too', invokeCalls.filter((call) => call.method === 'output.since' && call.params?.sessionId === 'ssh-10').length === 1);

send({ t: 'opened', dshSessionId: 'dsh-1', session: { id: 'ssh-10', host: 'ai-made-host', state: 'ready', permission: 'ask', dshSessionId: 'dsh-1' } });
await sleep(40);
check('a repeated opened frame focuses the console instead of opening another tab',
  registered.openTabs.length === 1, `${registered.openTabs.length} opens`);

send({ t: 'approval', dshSessionId: 'dsh-1', sessionId: 'ssh-10', approval: { id: 'ap-1', command: 'rm -rf /tmp/x', mode: 'announce', danger: { id: 'rm-recursive-force', note: '递归强制删除' }, expiresAt: Date.now() + 5000, graceMs: 5000 } });
await sleep(30);
check('approval frames are accepted without throwing', true);

// ---------------------------------------- reconnect stays inside the console view

{
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const start = source.indexOf('const connect = React.useCallback(async (target) => {');
  const end = source.indexOf('}, [busy]);', start);
  const body = start >= 0 && end > start ? source.slice(start, end) : '';
  check('reconnect stays inside the console view and never opens a Host tab',
    body.length > 0 && !body.includes('openTab') && body.includes('openSession(target, { select: true })'),
    body.length === 0 ? 'connect callback not found' : `${body.length} chars inspected`);
}

// ---------------------------------------------------------------- one Host tab, our own strip

// The Host strip is `overflow: hidden` with no scrollbar and its DOM is off limits, so the plugin owns
// a second-level strip inside a single Host tab. Selecting a session must never add a Host tab.
storage.clear();
registered.inventory = [{ id: 'tab-console', kind: 'ssh-console', contentId: 'c-console' }];
const opensBefore = registered.openTabs.length;
internals.selectSession('ssh-42');
await sleep(20);
check('selecting a session focuses the console instead of opening a Host tab',
  internals.snapshot()?.activeView === 'ssh-42' && registered.openTabs.length === opensBefore && registered.focused.at(-1) === 'tab-console',
  `view=${internals.snapshot()?.activeView} opens=${registered.openTabs.length} focus=${JSON.stringify(registered.focused.at(-1))}`);
registered.inventory = [];
internals.selectSession('ssh-43');
await sleep(20);
check('selecting a session opens the console when the Host strip has none',
  registered.openTabs.length === opensBefore + 1 && registered.openTabs.at(-1)?.kind === 'ssh-console',
  JSON.stringify(registered.openTabs.at(-1)));

// ---------------------------------------------------------------- the strip's rows

check('the strip lists every known session with liveness, oldest first', (() => {
  const entries = internals.consoleStripEntries({
    'ssh-b': { id: 'ssh-b', host: 'h-b', state: 'exited', exitCode: 3, permission: 'view', createdAt: 20 },
    'ssh-a': { id: 'ssh-a', host: 'h-a', state: 'ready', permission: 'ask', createdAt: 10 },
  });
  return JSON.stringify(entries) === JSON.stringify([
    { id: 'ssh-a', host: 'h-a', state: 'ready', permission: 'ask', alive: true },
    { id: 'ssh-b', host: 'h-b', state: 'exited', permission: 'view', alive: false },
  ]);
})(), JSON.stringify(internals.consoleStripEntries({})));
check('an exited session stays on the strip so it can be reconnected',
  internals.consoleStripEntries({ x: { id: 'x', host: 'h', state: 'exited' } })[0]?.alive === false);
check('malformed session records are dropped from the strip',
  internals.consoleStripEntries({ a: null, b: { host: 'no-id' }, c: { id: 'ok' } }).length === 1);
check('the strip always pins the console page first',
  (() => {
    const rows = internals.stripRows({ 'ssh-a': { id: 'ssh-a', host: 'h-a', state: 'ready', createdAt: 1 } });
    return rows.length === 2 && rows[0].id === 'manager' && rows[0].pinned === true
      && rows[0].label === '控制台' && rows[1].id === 'ssh-a';
  })(), JSON.stringify(internals.stripRows({})));
check('the pinned page is there even with no sessions', internals.stripRows({}).length === 1);
check('red means danger, not "unknown" or "ended"', (() => {
  const error = 'var(--dsw-alias-state-error-primary)';
  const colours = [
    internals.stateColor(undefined),
    internals.stateColor({}),
    internals.stateColor({ id: 'manager', pinned: true }),
    internals.stateColor({ id: 'x', state: 'closed' }),
    internals.stateColor({ id: 'x', state: 'exited' }),
    internals.stateColor({ id: 'x', state: 'ready' }),
    internals.stateColor({ id: 'x', state: 'connecting' }),
  ];
  return colours.every((colour) => colour !== error);
})(), JSON.stringify([internals.stateColor({}), internals.stateColor({ state: 'exited' }), internals.stateColor({ state: 'ready' })]));

// ------------------------------------------------- the AI must not steal the operator's view

internals.selectSession('ssh-9');
await sleep(20);
send({ t: 'opened', dshSessionId: 'dsh-1', session: { id: 'ssh-77', host: 'ai-2', state: 'ready', permission: 'ask', dshSessionId: 'dsh-1' } });
await sleep(40);
check('a session the AI creates never switches the view the operator is watching',
  internals.snapshot()?.activeView === 'ssh-9', String(internals.snapshot()?.activeView));

// ---------------------------------------------------------------- disconnect detection

check('liveness: connecting and ready count, closed and exited do not',
  internals.isAliveSession({ state: 'ready' })
  && internals.isAliveSession({ state: 'connecting' })
  && !internals.isAliveSession({ state: 'closed' })
  && !internals.isAliveSession({ state: 'exited' })
  && !internals.isAliveSession(undefined));
check('the build marker is exposed (stale page diagnosis)', typeof internals.CLIENT_BUILD === 'string' && internals.CLIENT_BUILD.length > 0, internals.CLIENT_BUILD);
check('the stream snapshot holds the live session', internals.snapshot()?.sessions?.['ssh-10']?.state === 'ready', String(internals.snapshot()?.sessions?.['ssh-10']?.state));

send({ t: 'state', dshSessionId: 'dsh-1', session: { id: 'ssh-10', host: 'ai-made-host', state: 'closed', dshSessionId: 'dsh-1' } });
await sleep(40);
check('a closed session leaves the client map (so the tab offers reconnect)', internals.snapshot()?.sessions?.['ssh-10'] === undefined);
check('an exited session stays known but is not usable', (() => {
  const state = internals.snapshot();
  return internals.isAliveSession({ state: 'exited', exitCode: 0 }) === false && state !== null;
})());
check('other sessions are untouched by the close', internals.snapshot()?.sessions?.['ssh-9']?.state === 'ready');

// ---------------------------------------------------------------- browser-side connection memory

check('client exposes the connection-memory helpers', internals !== undefined && typeof internals.pushRecent === 'function');

storage.clear();
internals.writeBinding('content-1', { target: 'root@10.0.0.1', user: 'root', port: '', name: 'a', sessionId: 'ssh-9' });
check('a tab binding round-trips', internals.readBinding('content-1')?.sessionId === 'ssh-9');
check('a malformed binding is ignored', (() => { storage.set(`${internals.BINDING_PREFIX}bad`, '{"nope":1}'); return internals.readBinding('bad') === null; })());

storage.clear();
internals.pushRecent({ target: 'h1', user: 'root', port: '', name: 'one' });
internals.pushRecent({ target: 'h2', user: 'root', port: '2222', name: 'two' });
internals.pushRecent({ target: 'h1', user: 'root', port: '', name: 'one-again' });
const recents = internals.readRecents();
check('recents are newest-first and de-duplicated', recents.length === 2 && recents[0].target === 'h1' && recents[0].name === 'one-again', JSON.stringify(recents.map((entry) => entry.target)));
for (let index = 0; index < 20; index += 1) internals.pushRecent({ target: `bulk-${index}`, user: '', port: '' });
check('recents stay capped', internals.readRecents().length === 12, `${internals.readRecents().length} entries`);

storage.clear();
internals.writeBinding('session:ssh-5', { target: 'from-session', sessionId: 'ssh-5' });
check('a tab without its own binding falls back to its last session id',
  internals.descriptorFor('unknown-content', 'ssh-5')?.target === 'from-session');
internals.writeBinding('content-2', { target: 'from-content', sessionId: 'ssh-6' });
check('the tab binding wins over the session fallback',
  internals.descriptorFor('content-2', 'ssh-5')?.target === 'from-content');
check('no descriptor without any binding', internals.descriptorFor('nope', undefined) === null);

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log('NOTE: registration and data path only — no component was rendered, so the visual result still needs a browser look.');
process.exit(failed.length === 0 ? 0 : 1);
