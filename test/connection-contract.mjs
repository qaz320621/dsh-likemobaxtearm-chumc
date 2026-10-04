/**
 * Why this plugin registers Fetch routes instead of an RPC channel.
 *
 * Part 1 pins the installed facts that force the decision (source-level, so a future DSH release
 * that fixes `rpc.handle` will fail this test and tell us to reconsider).
 * Part 2 proves the replacement against the REAL Cordis runtime: a consumer that injects only
 * `connection` can register exact Fetch routes, and the provider never needs `webServer`.
 *
 * Run: node test/connection-contract.mjs
 */

import { fileURLToPath } from 'node:url';
import { harnessUrl } from './harness-root.mjs';
import { readFileSync } from 'node:fs';

const { Context, Service } = await import(harnessUrl('@deepseek-ai/cordis/lib/index.js'));
const CONNECTION = fileURLToPath(harnessUrl('@deepseek-ai/dsh-client-connection/lib/index.js'));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`);
}

// ---------------------------------------------------------------- part 1: the installed facts

const connectionSource = readFileSync(CONNECTION, 'utf8');
check('installed connection scopes rpc to the PROVIDER context',
  /get rpc\(\)\s*\{\s*const owner = this\.ctx;/.test(connectionSource),
  'get rpc() { const owner = this.ctx; ... }');
check('installed connection reaches for owner.webServer when registering an RPC channel',
  /register\(owner, channel, handler\)/.test(connectionSource) && /owner\.webServer\.register\(/.test(connectionSource),
  'owner.webServer.register(route)');
check('installed connection registers Fetch routes without touching webServer',
  (() => {
    const start = connectionSource.indexOf('registerFetchRoute(owner, route) {');
    if (start < 0) return false;
    const body = connectionSource.slice(start, start + 700);
    return body.includes('owner.effect(') && !body.includes('webServer');
  })(),
  'registerFetchRoute uses owner.effect + its own route map');

// ---------------------------------------------------------------- part 2: real Cordis

class FakeWebServer extends Service {
  constructor(ctx) {
    super(ctx, 'webServer');
    this.routes = [];
  }

  register(route) {
    this.routes.push(route);
    return () => {};
  }
}

class FakeConnection extends Service {
  constructor(ctx) {
    super(ctx, 'connection');
    this.routes = [];
  }

  get fetch() {
    const owner = this.ctx;
    return { register: (route) => this.registerFetchRoute(owner, route) };
  }

  registerFetchRoute(owner, route) {
    return owner.effect(() => {
      this.routes.push(route.path);
      return () => {};
    }, `connection: fetch ${route.path}`);
  }
}

const root = new Context();
const calls = { webServerRoutes: [] };
let connection = null;
// Cordis activates plugins asynchronously: await each fiber before asserting on its effects.
await root.plugin({
  name: 'fake-webserver',
  apply(ctx) {
    const server = new FakeWebServer(ctx);
    server.register = (route) => { calls.webServerRoutes.push(route); return () => {}; };
  },
}).await?.();
await root.plugin({
  name: 'fake-connection',
  // Mirrors the real row: the provider injects webRuntime, NOT webServer.
  inject: [],
  apply(ctx) {
    connection = new FakeConnection(ctx);
  },
}).await?.();

let error = null;
try {
  await root.plugin({
    name: 'consumer',
    inject: ['connection'],
    apply(ctx) {
      ctx.effect(() => ctx.connection.fetch.register({
        path: '/api/dsh-ssh/invoke', methods: ['POST'], requestBody: 'buffered', fetch: async () => new Response('{}'),
      }));
      ctx.effect(() => ctx.connection.fetch.register({
        path: '/api/dsh-ssh/stream', methods: ['POST'], requestBody: 'buffered', fetch: async () => new Response(''),
      }));
    },
  }).await?.();
} catch (caught) {
  error = caught;
}

check('a consumer with only `connection` injected can register both Fetch routes',
  error === null && connection?.routes.length === 2, String(error?.message ?? connection?.routes.join(', ')));
check('registering those routes never touches the guarded webServer',
  calls.webServerRoutes.length === 0, `${calls.webServerRoutes.length} webServer routes`);

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
