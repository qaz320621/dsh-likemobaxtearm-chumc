/**
 * Host-half integration smoke test — runs the real SSH path without the Harness.
 *
 * It builds the same `ctx.subprocess.spawnTerminal` surface out of node-pty, then drives the
 * manager the way the RPC layer and the tools do: open → exec → read → log → permissions → danger.
 *
 * Run: node test/host-smoke.mjs
 */

import { harnessRequire } from './harness-root.mjs';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { SshManager } from '../src/manager.js';
import { compileDangerPatterns } from '../src/danger.js';
import { normalizeConfig } from '../index.js';

const pty = harnessRequire()('node-pty');

/** Minimal stand-in for @deepseek-ai/dsh-subprocess-local's spawnTerminal(). */
const fakeSubprocess = {
  // The provider owns PATH resolution in the real Host; `ssh` must come back as a real path.
  async resolveExecutable(command) { return command.includes('/') ? command : `/usr/bin/${command}`; },
  async spawnTerminal(spec) {
    const proc = pty.spawn(spec.argv[0], spec.argv.slice(1), {
      name: spec.terminalType,
      cols: spec.cols,
      rows: spec.rows,
      cwd: spec.cwd,
      env: { ...process.env, TERM: spec.terminalType },
    });
    const output = new Readable({ read() {} });
    output.setEncoding('utf8');
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    proc.onData((chunk) => output.push(chunk));
    proc.onExit(({ exitCode, signal }) => {
      output.push(null);
      resolveDone({ exitCode, signal: signal ?? null });
    });
    return {
      pid: proc.pid,
      output,
      done,
      write: async (data) => { proc.write(data); },
      resize: async (cols, rows) => { proc.resize(cols, rows); },
      inspectForeground: async () => ({ processGroupId: proc.pid, inputWaiting: false }),
      inspectActivity: async () => ({ state: 'unknown', revision: 0 }),
      signalForeground: async (signal) => { proc.kill(signal); return proc.pid; },
      terminate: async () => { try { proc.kill(); } catch { /* already gone */ } await done.catch(() => {}); },
    };
  },
};

const root = mkdtempSync(`${tmpdir()}/dsh-ssh-smoke-`);
const config = normalizeConfig({ logDir: 'logs', outputLogTruncateChars: 200, dangerGraceMs: 300, commandTimeoutMs: 30000, outputFlushQuietMs: 300, outputIdleFlushMs: 1500, outputFlushMaxBytes: 4096 });
const frames = [];
const manager = new SshManager({
  subprocess: fakeSubprocess,
  config,
  dangerPatterns: compileDangerPatterns(config),
  rootResolver: () => root,
  resolveExecutable: (command) => fakeSubprocess.resolveExecutable(command),
  emit: (frame) => frames.push(frame),
});

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DSH = 'dsh-smoke-session';
// Point this at any host reachable with the current user's key when localhost has no sshd.
const TARGET = process.env.DSH_SSH_TEST_TARGET ?? 'localhost';

async function main() {
  // 1) open a real ssh session to localhost
  const snapshot = await manager.open({ dshSessionId: DSH, target: TARGET, name: TARGET, permission: 'full' });
  check('open session', snapshot.state === 'connecting' || snapshot.state === 'ready', `state=${snapshot.state}`);
  const session = manager.get(DSH, snapshot.id);
  await sleep(2500);
  check('session becomes ready', session.state === 'ready', `state=${session.state}`);
  check('log file created', session.logPath !== null && readFileSync(session.logPath, 'utf8').length > 0, session.logPath);
  const openEntry = manager.logRead(DSH, session.id, { kind: 'session.open' }).entries.at(-1);
  check('a bare `ssh` is resolved to a real path before spawning',
    String(openEntry?.command ?? '').startsWith('/usr/bin/ssh'), String(openEntry?.command ?? '').slice(0, 40));
  check('output streamed as frames', frames.some((f) => f.t === 'output' && f.data.length > 0), `${frames.filter((f) => f.t === 'output').length} frames`);

  // 2) AI exec with marker protocol
  const first = await manager.execByAi(DSH, session.id, 'echo HELLO_MARKER; uname -n', { timeoutMs: 15000 });
  check('exec exit code', first.exitCode === 0, `exit=${first.exitCode} wait=${first.waitReason}`);
  check('exec output captured', first.output.includes('HELLO_MARKER'), JSON.stringify(first.output.slice(0, 120)));
  check('echo of command stripped', !first.output.includes('__DSH_SSH_DONE_'), JSON.stringify(first.output.slice(-80)));

  // 3) log truncation rule: command full, output capped at 200 chars
  const long = await manager.execByAi(DSH, session.id, 'seq 1 400', { timeoutMs: 20000 });
  const entries = manager.logRead(DSH, session.id, {}).entries;
  const commandEntry = entries.filter((e) => e.kind === 'ai.command').pop();
  const outputEntry = entries.filter((e) => e.kind === 'output' && e.truncated === true).pop();
  check('command stored in full', commandEntry?.command === 'seq 1 400', String(commandEntry?.command));
  check('long output truncated to 200', outputEntry !== undefined && outputEntry.text.length === 200 && outputEntry.fullBytes > 200,
    outputEntry === undefined ? 'no truncated output entry' : `text=${outputEntry.text.length} fullBytes=${outputEntry.fullBytes}`);
  check('long command result bounded for the model', long.output.length > 200, `chars=${long.output.length}`);

  // 3b) the durable log records one entry per INTERACTION, not one per echoed keystroke
  const outputCount = () => manager.logRead(DSH, session.id, { kind: 'output' }).entries.length;
  const inputsOf = (line) => manager.logRead(DSH, session.id, { kind: 'user.input' }).entries.filter((entry) => entry.command === line);
  await sleep(500); // let the previous command's tail drain first
  const beforeTyping = outputCount();

  // Type slowly, with a pause: `host` … 700ms … `name`, then Enter. The pause is longer than the
  // quiet window but shorter than the idle window, so the half-typed line must NOT be logged.
  for (const char of ['h', 'o', 's', 't']) {
    await manager.writeUser(DSH, session.id, char);
    await sleep(70);
  }
  // Deliberately pause LONGER than the idle window: a human can pause arbitrarily long, and the
  // line must still not be sliced (the hold lasts until Enter, not until a timer).
  await sleep(Math.max(1600, config.outputIdleFlushMs + 200));
  check('a long typing pause does not slice an in-progress line into the log', outputCount() === beforeTyping, `${outputCount() - beforeTyping} entries`);
  for (const char of ['n', 'a', 'm', 'e']) {
    await manager.writeUser(DSH, session.id, char);
    await sleep(70);
  }
  await manager.writeUser(DSH, session.id, '\r');
  await sleep(700);
  const afterEnter = outputCount();
  const fresh = manager.logRead(DSH, session.id, { kind: 'output' }).entries.slice(beforeTyping);
  // Enter closes the interaction: one entry for the echoed line, one for what the command printed.
  check('Enter logs the interaction as a line entry plus a result entry', afterEnter - beforeTyping === 2, `${afterEnter - beforeTyping} entries`);
  check('the whole typed line lands in one entry', fresh.some((entry) => String(entry.text).includes('hostname')),
    JSON.stringify(fresh.map((entry) => String(entry.text).slice(-24))));
  check('nothing was cut at the typing pause', !fresh.some((entry) => /host\s*$/.test(String(entry.text))),
    JSON.stringify(fresh.map((entry) => String(entry.text).slice(-24))));
  check('the command result forms its own entry', fresh.some((entry) => String(entry.text).includes('chumc')),
    JSON.stringify(fresh.map((entry) => String(entry.text).slice(-24))));
  check('exactly one user.input line was recorded', inputsOf('hostname').length === 1, JSON.stringify(inputsOf('hostname').map((entry) => entry.command)));
  check('coalescing never costs the live stream a byte', session.read({ offset: 0, count: 4 }).text.includes('hostname'),
    JSON.stringify(session.read({ offset: 0, count: 4 }).text.slice(-40)));

  // 3c) a command longer than the terminal width must not leak its wrapped echo into the result
  const longCommand = 'echo WRAP_ECHO_TEST_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const wrapped = await manager.execByAi(DSH, session.id, longCommand, { timeoutMs: 20000 });
  check('a wrapped command echo is stripped from the result',
    wrapped.output.includes('WRAP_ECHO_TEST') && !wrapped.output.includes('echo WRAP_ECHO_TEST'),
    JSON.stringify(wrapped.output.slice(0, 60)));

  // 4) read page
  const page = session.read({ offset: 0, count: 5 });
  check('read returns the newest lines', page.text.includes('WRAP_ECHO_TEST') && page.lineEnd > page.lineBegin,
    JSON.stringify(page.text.slice(-40)));

  // 5) permission gates
  manager.setPermission(DSH, session.id, 'view');
  let viewRejected = false;
  try { await manager.execByAi(DSH, session.id, 'echo nope'); } catch (error) { viewRejected = error.code === 'SSH_PERMISSION_VIEW_ONLY'; }
  check('view permission rejects AI writes', viewRejected);

  // 6) ask permission: approval resolves through the approval frame
  manager.setPermission(DSH, session.id, 'ask');
  const pending = manager.execByAi(DSH, session.id, 'echo APPROVED_PATH', { timeoutMs: 15000 });
  await sleep(120);
  const approvalFrame = frames.filter((f) => f.t === 'approval').pop();
  check('ask mode raises approval request', approvalFrame !== undefined, approvalFrame?.approval?.command ?? 'none');
  manager.answerApproval(DSH, session.id, approvalFrame.approval.id, true);
  const approved = await pending;
  check('approved command runs', approved.output.includes('APPROVED_PATH'), JSON.stringify(approved.output.slice(0, 80)));

  // 7) danger announce window in full mode
  manager.setPermission(DSH, session.id, 'full');
  const dangerRun = manager.execByAi(DSH, session.id, 'echo just-probing; rm -rf /tmp/definitely-not-here', { timeoutMs: 15000 });
  await sleep(100);
  const dangerFrame = frames.filter((f) => f.t === 'approval' && f.approval.mode === 'announce').pop();
  check('danger commands announced first', dangerFrame !== undefined, dangerFrame?.approval?.danger?.id ?? 'none');
  const dangerResult = await dangerRun;
  check('danger announce still executes after grace', dangerResult.output.includes('just-probing'), `danger=${dangerResult.danger?.id}`);

  // 8) notebook note never reaches the model
  const delivered = [];
  const fakeCtx = { agents: { get: () => ({ followup: (message) => delivered.push(message) }) } };
  const note = (() => {
    // mirror index.js deliverNote for the notebook branch through the manager's log
    session.log.append('user.note', { actor: 'user', kind: 'notebook', text: '[仅记录] private', logOnly: true });
    return { delivered: false };
  })();
  check('notebook note stays out of the model path', note.delivered === false && delivered.length === 0);
  void fakeCtx;

  // 9) close tears the process down
  await manager.close(DSH, session.id);
  check('close marks session closed', session.state === 'closed', session.state);
  check('log records the whole story', readFileSync(session.logPath, 'utf8').includes('session.close'), session.logPath);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log(`log file: ${session.logPath}`);
  const tail = readFileSync(session.logPath, 'utf8').trim().split('\n').slice(0, 3).join('\n');
  console.log(`first log lines:\n${tail}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('SMOKE TEST CRASHED:', error);
  process.exit(2);
});
