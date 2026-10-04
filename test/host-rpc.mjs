/**
 * Wiring-level integration test: loads the real `index.js`, drives the RPC surface, the browser
 * stream and all nine tools, and validates every tool schema with the Harness's OWN validator
 * (imported from the installed dsh-tools, not re-implemented here).
 *
 * Run: node test/host-rpc.mjs
 */

import { harnessRequire } from './harness-root.mjs';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { apply, Config, inject as declaredInject, normalizeConfig } from '../index.js';
import { SshManager } from '../src/manager.js';
import { compileDangerPatterns } from '../src/danger.js';

const installRequire = harnessRequire();
const pty = installRequire('node-pty');
const harnessTools = installRequire('@deepseek-ai/dsh-tools');

const root = mkdtempSync(`${tmpdir()}/dsh-ssh-rpc-`);
const TARGET = process.env.DSH_SSH_TEST_TARGET ?? 'localhost';
const config = normalizeConfig({
  defaultPermission: 'full',
  logDir: 'logs',
  dangerGraceMs: 200,
  commandTimeoutMs: 20000,
  approvalTimeoutMs: 8000,
  outputFlushQuietMs: 300,
  workspaceRoot: root,
});
const DSH = 'dsh-rpc-test';

// ----------------------------------------------------------------- fake Host context

const fakeSubprocess = {
  async spawnTerminal(spec) {
    const proc = pty.spawn(spec.argv[0], spec.argv.slice(1), {
      name: spec.terminalType, cols: spec.cols, rows: spec.rows, cwd: spec.cwd,
      env: { ...process.env, TERM: spec.terminalType },
    });
    const output = new Readable({ read() {} });
    output.setEncoding('utf8');
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    proc.onData((chunk) => output.push(chunk));
    proc.onExit(({ exitCode, signal }) => { output.push(null); settle({ exitCode, signal: signal ?? null }); });
    return {
      pid: proc.pid,
      output,
      done,
      write: async (data) => { proc.write(data); },
      resize: async (cols, rows) => { proc.resize(cols, rows); },
      inspectForeground: async () => ({ processGroupId: proc.pid, inputWaiting: false }),
      inspectActivity: async () => ({ state: 'unknown', revision: 0 }),
      signalForeground: async (signal) => { proc.kill(signal); return proc.pid; },
      terminate: async () => { try { proc.kill(); } catch { /* gone */ } await done.catch(() => {}); },
    };
  },
};

const delivered = [];
// Exactly the real Agent shape: `id` plus `session` — there is NO `sessionId` property, and this
// test must fail if the tools ever read one again.
const agent = {
  id: DSH,
  session: { id: DSH, header: { cwd: root } },
  followup: (message) => delivered.push(message),
  inject: (message) => delivered.push(message),
};

const SERVICE_NAMES = new Set(['subprocess', 'tools', 'systemPrompt', 'connection', 'agents', 'webServer']);

/**
 * A fake context that enforces Cordis's inject rule the way the real proxy does, so a missing
 * declaration fails here instead of on the operator's next restart.
 */
function guardServices(target, declared) {
  return new Proxy(target, {
    get(inner, prop, receiver) {
      if (typeof prop === 'string' && SERVICE_NAMES.has(prop) && !declared.includes(prop)) {
        throw new Error(`cannot get property "${prop}" without inject`);
      }
      return Reflect.get(inner, prop, receiver);
    },
  });
}

const captured = { routes: new Map(), tools: [], prompt: null, disposers: [] };
let ctxProxy = null;
const hostTarget = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect(execute, label) {
    const disposer = execute();
    captured.disposers.push({ label, disposer });
    return () => { try { disposer?.(); } catch { /* ignore */ } };
  },
  subprocess: fakeSubprocess,
  agents: { get: (id) => (id === DSH ? agent : undefined), list: () => [agent], roots: () => [agent] },
  connection: {
    // Only `fetch` exists, exactly like the provider-scoped reality: any use of `rpc.handle` is a
    // TypeError here, which is how a regression would announce itself.
    fetch: { register: (route) => { captured.routes.set(route.path, route); return () => {}; } },
  },
  tools: { register: (definition) => { captured.tools.push(definition); return () => {}; } },
  systemPrompt: { section: (section) => { captured.prompt = section; return () => {}; } },
};
ctxProxy = guardServices(hostTarget, declaredInject);
const ctx = ctxProxy;

// ----------------------------------------------------------------- helpers

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Drive the real unary Fetch route exactly as the browser does. */
async function invokeRoute(method, params) {
  const route = captured.routes.get('/api/dsh-ssh/invoke');
  if (route === undefined) throw new Error('the invoke route was not registered');
  const request = new Request('http://127.0.0.1/api/dsh-ssh/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  const response = await route.fetch(request);
  if (response.status !== 200) throw new Error(`invoke route HTTP ${response.status}`);
  return response.json();
}
async function rpc(method, params) {
  const payload = await invokeRoute(method, params);
  if (payload.ok !== true) throw new Error(`${payload.error.code}: ${payload.error.message}`);
  return payload.value;
}
async function rpcRaw(method, params) { return invokeRoute(method, params); }

const tool = (name) => captured.tools.find((entry) => entry.name === name);
const exec = (args) => ({ agent, signal: new AbortController().signal, callId: 'call-1', name: 'x', arguments: args });

/** Open the browser stream and collect frames in the background. */
async function openStream() {
  const request = new Request('http://127.0.0.1/api/dsh-ssh/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dshSessionId: DSH }),
  });
  const route = captured.routes.get('/api/dsh-ssh/stream');
  if (route === undefined) throw new Error('the stream route was not registered');
  const response = await route.fetch(request);
  const frames = [];
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  (async () => {
    let rest = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done === true) break;
      rest += value;
      let index = rest.indexOf('\n');
      while (index >= 0) {
        const line = rest.slice(0, index);
        rest = rest.slice(index + 1);
        if (line.trim().length > 0) { try { frames.push(JSON.parse(line)); } catch { /* ignore */ } }
        index = rest.indexOf('\n');
      }
    }
  })().catch(() => {});
  return { frames, response };
}

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) return undefined;
    await sleep(60);
  }
}

// ----------------------------------------------------------------- the test

async function main() {
  check('Config is a standard schema', typeof Config?.['~standard']?.validate === 'function');
  const validated = Config['~standard'].validate({ defaultPermission: 'full', logDir: 'logs', dangerGraceMs: 200, commandTimeoutMs: 20000, approvalTimeoutMs: 8000, workspaceRoot: root });
  check('Config validator applies defaults', validated.issues === undefined && validated.value.defaultPermission === 'full' && validated.value.maxReadBytes > 0);
  const bad = Config['~standard'].validate('not-an-object');
  check('Config validator tolerates junk input', bad.issues === undefined || Array.isArray(bad.issues));

  let activationError = null;
  try {
    apply(ctx, config);
  } catch (error) {
    activationError = error;
  }
  check('apply() activates under an inject-enforcing context', activationError === null, String(activationError?.message ?? ''));
  check('the inject guard itself rejects an undeclared service', (() => {
    try { void guardServices({ tools: {} }, []).tools; return false; } catch (error) { return /without inject/.test(String(error.message)); }
  })());

  check('two Fetch routes registered (invoke + stream)', captured.routes.size === 2, [...captured.routes.keys()].join(', '));
  check('unary route registered on /api/dsh-ssh/invoke', captured.routes.has('/api/dsh-ssh/invoke'));
  check('stream route registered on /api/dsh-ssh/stream', captured.routes.has('/api/dsh-ssh/stream'));
  check('no prefix RPC channel is exposed (the consumer-broken API)', hostTarget.connection.rpc === undefined);
  check('nine tools registered', captured.tools.length === 9, captured.tools.map((entry) => entry.name).join(', '));
  check('prompt section registered', captured.prompt?.name === 'tool:ssh', String(captured.prompt?.name));

  // --- the Harness's own validator decides whether our hand-built schemas are legal
  let schemaOk = true;
  let schemaDetail = '';
  for (const definition of captured.tools) {
    try {
      harnessTools.assertObjectJsonSchema(definition.parameters);
      harnessTools.assertSupportedJsonSchema(definition.output.schema);
      if (typeof definition.output.render !== 'function') throw new Error('missing render');
      if (typeof definition.execute !== 'function') throw new Error('missing execute');
    } catch (error) {
      schemaOk = false;
      schemaDetail += `${definition.name}: ${error.message}; `;
    }
  }
  check('every tool schema passes the real Harness validator', schemaOk, schemaDetail);

  // --- required/typed arguments are declared where we intend them
  const violations = [];
  for (const definition of captured.tools) {
    for (const bad of [{}, { sessionId: 42 }, null]) {
      const found = harnessTools.validateJsonSchemaValue(definition.parameters, bad, '');
      if (found.length === 0 && definition.name !== 'ssh_list_hosts' && definition.name !== 'ssh_list_sessions') {
        violations.push(`${definition.name} accepted ${JSON.stringify(bad)}`);
      }
    }
  }
  check('tools reject wrong argument shapes', violations.length === 0, violations.slice(0, 2).join('; '));

  // --- browser stream + RPC surface
  const stream = await openStream();
  check('stream returns chunked NDJSON', stream.response.status === 200, stream.response.headers.get('content-type') ?? '');
  const hello = await waitFor(() => stream.frames.find((frame) => frame.t === 'hello'));
  check('stream sends a hello snapshot', hello !== undefined, hello === undefined ? 'no hello' : `logDir=${hello.logDir}`);

  const helloRpc = await rpc('hello', { dshSessionId: DSH });
  check('rpc hello works', Array.isArray(helloRpc.hosts) && typeof helloRpc.logDir === 'string');

  const saved = await rpc('hosts.save', { profile: { name: '本机', target: TARGET } });
  check('hosts.save persists a profile', saved.hosts.length === 1 && saved.hosts[0].target === TARGET, saved.host?.id);
  const listed = await rpc('hosts.list', {});
  check('hosts.list reads it back', listed.hosts.length === 1);

  const opened = await rpc('session.open', { dshSessionId: DSH, target: TARGET, name: TARGET });
  const sessionId = opened.session.id;
  check('session.open creates a session', typeof sessionId === 'string' && opened.session.state !== 'exited', `${sessionId} ${opened.session.state}`);
  check('opened frame streamed to the browser', await waitFor(() => stream.frames.find((frame) => frame.t === 'opened')) !== undefined);
  check('output frames reach the browser', await waitFor(() => stream.frames.find((frame) => frame.t === 'output' && frame.data.length > 0)) !== undefined);

  await sleep(1500);
  const since = await rpc('output.since', { dshSessionId: DSH, sessionId, from: 0 });
  check('output.since replays the session', typeof since.data === 'string' && since.data.length > 0 && since.seq > 0, `${since.data.length} chars, seq=${since.seq}`);

  // --- ssh_exec through the real tool, in `full` permission
  const execTool = tool('ssh_exec');
  const execResult = await execTool.execute({ sessionId, command: 'echo TOOL_PATH_OK; uname -n' }, exec({ sessionId, command: 'echo TOOL_PATH_OK; uname -n' }));
  const rendered = execTool.output.render({}, execResult).map((block) => block.text).join('\n');
  check('ssh_exec tool runs a command', execResult.exitCode === 0 && String(execResult.output).includes('TOOL_PATH_OK'), `exit=${execResult.exitCode} wait=${execResult.waitReason}`);
  check('ssh_exec render is model-readable text', rendered.includes('exit 0') && rendered.includes('TOOL_PATH_OK'), JSON.stringify(rendered.slice(0, 60)));
  check('tool result passes the real output validator', harnessTools.validateJsonSchemaValue(execTool.output.schema, execResult, '').length === 0);

  check('danger detection reaches the tool', (await execTool.execute({ sessionId, command: 'rm -rf /tmp/dsh-ssh-nope' }, exec({}))).danger?.id === 'rm-recursive-force');
  check('danger announce frame streamed', await waitFor(() => stream.frames.find((frame) => frame.t === 'approval' && frame.approval.mode === 'announce')) !== undefined);

  const readTool = tool('ssh_read');
  const readResult = await readTool.execute({ sessionId, count: 10 }, exec({}));
  check('ssh_read returns plain lines without sentinels', typeof readResult.text === 'string' && !readResult.text.includes('__DSH_SSH_DONE_'), JSON.stringify(String(readResult.text).slice(-40)));

  const logTool = tool('ssh_log');
  const logResult = await logTool.execute({ sessionId, limit: 50 }, exec({}));
  check('ssh_log exposes the audit trail', Array.isArray(logResult.entries) && logResult.entries.some((entry) => entry.kind === 'ai.command'), `${logResult.entries?.length} entries`);
  check('log keeps commands in full', logResult.entries.some((entry) => entry.command === 'echo TOOL_PATH_OK; uname -n'));

  const statusTool = tool('ssh_status');
  const status = await statusTool.execute({ sessionId }, exec({}));
  check('ssh_status reports permission and owner', status.permission === 'full' && typeof status.inputOwner === 'string', `${status.permission}/${status.inputOwner}`);

  // --- permission gates through the tool surface
  await rpc('session.permission', { dshSessionId: DSH, sessionId, permission: 'view' });
  const viewDenied = await execTool.execute({ sessionId, command: 'echo nope' }, exec({})).then(() => null, (error) => error);
  check('view permission blocks ssh_exec', viewDenied !== null && /仅可看/.test(String(viewDenied.message)), String(viewDenied?.message).slice(0, 40));

  await rpc('session.permission', { dshSessionId: DSH, sessionId, permission: 'ask' });
  const pendingExec = execTool.execute({ sessionId, command: 'echo APPROVED_VIA_RPC' }, exec({}));
  const approvalFrame = await waitFor(() => stream.frames.find((frame) => frame.t === 'approval' && frame.approval.mode === 'approve'));
  check('ask permission raises an approval frame', approvalFrame !== undefined, approvalFrame?.approval?.command);
  await rpc('approval.answer', { dshSessionId: DSH, sessionId, approvalId: approvalFrame.approval.id, approve: true });
  const approvedResult = await pendingExec;
  check('approved command executed', String(approvedResult.output).includes('APPROVED_VIA_RPC'));
  check('approval-resolved frame streamed', await waitFor(() => stream.frames.find((frame) => frame.t === 'approval-resolved')) !== undefined);

  const deniedExec = execTool.execute({ sessionId, command: 'echo SHOULD_NOT_RUN' }, exec({}));
  const denyFrame = await waitFor(() => {
    const frames = stream.frames.filter((frame) => frame.t === 'approval' && frame.approval.mode === 'approve');
    return frames.length >= 2 ? frames[frames.length - 1] : undefined;
  });
  await rpc('approval.answer', { dshSessionId: DSH, sessionId, approvalId: denyFrame.approval.id, approve: false });
  const deniedResult = await deniedExec.then(() => null, (error) => error);
  check('denied command does not run', deniedResult !== null && /拒绝/.test(String(deniedResult.message)), String(deniedResult?.message).slice(0, 40));

  // --- notes: three kinds
  await rpc('session.permission', { dshSessionId: DSH, sessionId, permission: 'full' });
  const before = delivered.length;
  const notebook = await rpc('note.send', { dshSessionId: DSH, sessionId, kind: 'notebook', text: '自己记一笔' });
  check('notebook note is log-only', notebook.delivered === false && delivered.length === before, notebook.reason);
  const question = await rpc('note.send', { dshSessionId: DSH, sessionId, kind: 'question', text: '这台机器磁盘够吗？' });
  check('question note goes to the AI', question.delivered === true && delivered.length === before + 1, question.via);
  const questionMessage = delivered[delivered.length - 1];
  const official = installRequire('@deepseek-ai/dsh-llm').createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } });
  const ours = delivered[delivered.length - 1];
  const sameShape = JSON.stringify(Object.keys(ours).sort()) === JSON.stringify(Object.keys(official).sort())
    && typeof ours.id === 'string' && ours.id.length > 0
    && ours.role === official.role
    && JSON.stringify(ours.source) === JSON.stringify({ kind: 'user' })
    && JSON.stringify(ours.content) === JSON.stringify([{ type: 'text', text: String(ours.content?.[0]?.text ?? '') }])
    && Object.isFrozen(ours) && Object.isFrozen(ours.content[0]);
  check('hand-built message matches the official createUserMessage shape', sameShape, Object.keys(ours).sort().join(','));
  check('note arrives as a real user message', questionMessage?.role === 'user' && questionMessage?.source?.kind === 'user' && String(questionMessage?.content?.[0]?.text).includes('SSH 用户留言'), Object.keys(questionMessage ?? {}).join(','));
  const errorNote = await rpc('note.send', { dshSessionId: DSH, sessionId, kind: 'error', text: '这个报错怎么解？' });
  check('error note attaches recent output', errorNote.delivered === true && String(delivered[delivered.length - 1]?.content?.[0]?.text).includes('最近终端输出'));

  // --- log truncation contract, as the operator specified
  const longRun = await execTool.execute({ sessionId, command: 'seq 1 500' }, exec({}));
  const logAfter = await logTool.execute({ sessionId, limit: 200 }, exec({}));
  const truncated = logAfter.entries.filter((entry) => entry.kind === 'output' && entry.truncated === true).pop();
  check('long output truncated to 200 in the log', truncated !== undefined && truncated.text.length === 200 && truncated.fullBytes > 200,
    truncated === undefined ? 'none' : `${truncated.text.length}/${truncated.fullBytes}`);
  check('command stays full in the log', logAfter.entries.some((entry) => entry.command === 'seq 1 500'));
  check('model still receives the real output', String(longRun.output).includes('500'));

  // --- lifecycle
  const sessions = await rpc('sessions.list', { dshSessionId: DSH });
  check('sessions.list sees the session', sessions.sessions.length === 1);
  const wrongOwner = await rpcRaw('sessions.list', { dshSessionId: 'someone-else' });
  check('sessions are scoped to their DSH session', wrongOwner.ok === true && wrongOwner.value.sessions.length === 0);
  const foreign = await rpcRaw('session.permission', { dshSessionId: 'someone-else', sessionId, permission: 'full' });
  check('foreign writes are rejected', foreign.ok === false && foreign.error.code === 'SSH_FOREIGN_SESSION', foreign.error?.code);
  const badMethod = await rpcRaw('nonsense', {});
  check('unknown rpc method fails cleanly', badMethod.ok === false && badMethod.error.code === 'SSH_BAD_METHOD');

  const closed = await rpc('session.close', { dshSessionId: DSH, sessionId });
  check('session.close reports success', closed.closed === true);

  // The operator asked for logs under the WORKSPACE, not the Harness process cwd. Without an
  // explicit override the root must come from the Agent's session header.
  {
    const workspace = mkdtempSync(`${tmpdir()}/dsh-ssh-workspace-`);
    const second = { routes: new Map(), tools: [], prompt: null };
    const secondAgent = { id: 'second', session: { id: 'second', header: { cwd: workspace } }, followup: () => {}, inject: () => {} };
    const secondTarget = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      effect: (execute) => { execute(); return () => {}; },
      subprocess: fakeSubprocess,
      agents: { get: () => secondAgent, list: () => [secondAgent], roots: () => [secondAgent] },
      connection: {
        fetch: { register: (route) => { second.routes.set(route.path, route); return () => {}; } },
      },
      tools: { register: (definition) => { second.tools.push(definition); return () => {}; } },
      systemPrompt: { section: () => () => {} },
    };
    const secondProxy = guardServices(secondTarget, declaredInject);
    apply(secondProxy, { logDir: 'logs' });
    const secondRoute = second.routes.get('/api/dsh-ssh/invoke');
    const secondResponse = await secondRoute.fetch(new Request('http://127.0.0.1/api/dsh-ssh/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'hello', params: { dshSessionId: 'second' } }),
    }));
    const secondHello = await secondResponse.json();
    const reported = secondHello.ok === true ? secondHello.value.logDir : '';
    check('logs land under the session workspace, not the process cwd', reported === `${workspace}/logs`,
      `${reported} (process cwd is ${process.cwd()})`);

    // An agent without any usable identity must fail loudly, never silently scope to everything.
    const broken = tool('ssh_list_sessions');
    let brokenError = null;
    try {
      await broken.execute({}, { agent: { session: {} }, signal: new AbortController().signal });
    } catch (error) {
      brokenError = error;
    }
    check('a tool call without a resolvable DSH session id fails loudly',
      brokenError !== null && /DSH 会话 id/.test(String(brokenError.message)), String(brokenError?.message ?? 'no error').slice(0, 50));
  }

  // The premature-fallback bug: `hello` arrives before any Agent is live, and caching that guess
  // pinned every later session (and the hosts file) to the Harness process cwd.
  {
    const answers = [null, null, '/workspace/real'];
    const probe = new SshManager({
      subprocess: fakeSubprocess,
      config,
      dangerPatterns: compileDangerPatterns(config),
      rootResolver: () => (answers.length > 0 ? answers.shift() : '/workspace/real'),
      emit: () => {},
    });
    const first = probe.root;
    const second = probe.root;
    const third = probe.root;
    check('a root fallback is reported but never cached',
      first === process.cwd() && second === process.cwd() && third === '/workspace/real',
      `${first} → ${second} → ${third}`);
    check('the hosts file follows a late root resolution',
      probe.hosts.path === '/workspace/real/.dsh-ssh/hosts.json', probe.hosts.path);
  }

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  for (const { disposer } of captured.disposers) {
    try { disposer?.(); } catch { /* ignore */ }
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('RPC TEST CRASHED:', error);
  process.exit(2);
});
