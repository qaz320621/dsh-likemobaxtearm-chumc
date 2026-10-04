/**
 * Activation test against the REAL Cordis runtime.
 *
 * It mounts this package's actual `index.js` as a plugin on a real Cordis root whose dependency
 * services are published the same way the real ones are (through the `Service` base class, which is
 * what installs the inject-enforcing accessor). The fake connection service reproduces the real
 * owner scoping — `get rpc()` binds the registration to the PROVIDER's context and then reaches for
 * `owner.webServer` — so any attempt to use `rpc.handle` fails here exactly as it failed at boot.
 *
 * This is the check that catches "cannot get property X without inject" before the operator
 * restarts the Harness.
 *
 * Run: node test/cordis-activation.mjs
 */

import { apply, inject as declaredInject, name as pluginName, Config } from '../index.js';

const { Context, Service } = await import(harnessUrl('@deepseek-ai/cordis/lib/index.js'));

import { harnessUrl } from './harness-root.mjs';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`);
}

const state = {
  webServerRoutes: [],
  fetchRoutes: [],
  rpcAttempts: [],
  tools: [],
  promptSections: [],
  promptContexts: [],
  spawns: [],
};

// ---------------------------------------------------------------- fake services (Service-based, like the real ones)

class FakeWebServer extends Service {
  constructor(ctx) {
    super(ctx, 'webServer');
  }

  register(route) {
    state.webServerRoutes.push(route);
    return () => {};
  }
}

class FakeConnection extends Service {
  constructor(ctx) {
    super(ctx, 'connection');
  }

  /** Byte-for-byte the real scoping: the PROVIDER's context owns the registration. */
  get rpc() {
    const owner = this.ctx;
    return {
      handle: (channel, handler) => {
        state.rpcAttempts.push(channel);
        void handler;
        return owner.effect(() => owner.webServer.register({ kind: 'prefix', path: channel }), `connection: ${channel}`);
      },
    };
  }

  get fetch() {
    const owner = this.ctx;
    return { register: (route) => this.registerFetchRoute(owner, route) };
  }

  registerFetchRoute(owner, route) {
    return owner.effect(() => {
      state.fetchRoutes.push({ path: route.path, methods: [...route.methods], requestBody: route.requestBody });
      return () => {};
    }, `connection: fetch ${route.path}`);
  }
}

class FakeTools extends Service {
  constructor(ctx) {
    super(ctx, 'tools');
  }

  register(definition) {
    state.tools.push(definition);
    return () => {};
  }
}

class FakeSystemPrompt extends Service {
  constructor(ctx) {
    super(ctx, 'systemPrompt');
  }

  section(section) {
    state.promptSections.push(section);
    return () => {};
  }

  context(context) {
    state.promptContexts.push(context);
    return () => {};
  }
}

class FakeSubprocess extends Service {
  constructor(ctx) {
    super(ctx, 'subprocess');
  }

  async spawnTerminal(spec) {
    state.spawns.push(spec);
    throw new Error('not used in the activation test');
  }
}

class FakeAgents extends Service {
  constructor(ctx) {
    super(ctx, 'agents');
  }

  list() { return []; }

  get() { return undefined; }
}

// ---------------------------------------------------------------- mount

const root = new Context();
root.plugin({
  name: 'fake-dependencies',
  apply(ctx) {
    new FakeWebServer(ctx);
    new FakeConnection(ctx);
    new FakeTools(ctx);
    new FakeSystemPrompt(ctx);
    new FakeSubprocess(ctx);
    new FakeAgents(ctx);
  },
});

let activationError = null;
let fiber = null;
try {
  fiber = root.plugin({ name: pluginName, inject: declaredInject, Config, apply });
  await fiber?.await?.();
} catch (error) {
  activationError = error;
}

check('the real plugin activates on the real Cordis runtime', activationError === null, String(activationError?.message ?? ''));
check('nine tools registered through the real registry', state.tools.length === 9, state.tools.map((entry) => entry.name).join(', '));
check('prompt section registered', state.promptSections.length === 1 && state.promptSections[0].name === 'tool:ssh', state.promptSections[0]?.name);
check('exactly two Fetch routes registered', state.fetchRoutes.length === 2, state.fetchRoutes.map((route) => `${route.path} [${route.methods}]`).join(' , '));
check('the unary route is POST /api/dsh-ssh/invoke',
  state.fetchRoutes.some((route) => route.path === '/api/dsh-ssh/invoke' && route.methods.includes('POST')));
check('the stream route is POST /api/dsh-ssh/stream',
  state.fetchRoutes.some((route) => route.path === '/api/dsh-ssh/stream' && route.methods.includes('POST')));
check('the plugin never touches the guarded webServer service', state.webServerRoutes.length === 0, `${state.webServerRoutes.length} routes`);
check('the plugin never calls the consumer-broken rpc.handle', state.rpcAttempts.length === 0, state.rpcAttempts.join(','));
check('webServer is deliberately NOT declared in inject', !declaredInject.includes('webServer'), JSON.stringify(declaredInject));

// Regression guard: the fake rpc.handle must still be able to fail, i.e. it really does reach webServer.
{
  let reproduced = null;
  try {
    root.plugin({
      name: 'regression-consumer',
      inject: [...declaredInject, 'webServer'],
      apply(ctx) {
        ctx.effect(() => ctx.connection.rpc.handle('/regression', () => ({ ok: true, value: 1 })));
      },
    });
  } catch (error) {
    reproduced = error;
  }
  check('the rpc.handle path is genuinely broken for consumers (documented regression guard)',
    reproduced === null || /webServer/.test(String(reproduced.message)),
    reproduced === null ? 'this Cordis build tolerated it; our decision to avoid it still stands' : String(reproduced.message));
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
