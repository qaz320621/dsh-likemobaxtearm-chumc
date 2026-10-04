/**
 * Host half of the SSH console bundle.
 *
 * Wiring only: configuration, the session manager, the browser channels, the model-facing tools
 * and the prompt section. Everything Harness-facing is hand-built, because a profile-installed
 * bundle cannot resolve `@deepseek-ai/*` specifiers from its own directory.
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { parseDurationMs } from './src/log.js';

import { compileDangerPatterns } from './src/danger.js';
import { SshManager } from './src/manager.js';
import { createHub, createSshRpc } from './src/rpc.js';
import { createSshTools, SSH_PROMPT_SECTION } from './src/tools.js';

export const name = 'dsh-likemobaxtearm-chumc';
// No `webServer` here on purpose: `connection.rpc.handle` needs it on the PROVIDER's fiber and is
// therefore unusable for consumers, so this plugin registers only `connection.fetch` routes.
export const inject = ['subprocess', 'tools', 'systemPrompt', 'connection', 'agents'];

/** @type {Record<string, unknown>} */
export const DEFAULTS = {
  workspaceRoot: '',
  logDir: '.dsh-ssh/logs',
  logEnabled: true,
  outputLogTruncateChars: 200,
  maxLogBytesPerSession: 8 * 1024 * 1024,
  // Days, or a duration string (`12h`, `90m`); fractions are honoured, so 0.5 = twelve hours.
  // 0 disables archiving — it never means "archive everything now".
  logArchiveAfterDays: 7,
  logRetentionDays: 0,    // archives older than this are deleted; 0 = keep history forever
  maxReadBytes: 262144,
  outputFlushQuietMs: 400,
  outputIdleFlushMs: 5000,
  outputFlushMaxBytes: 8192,
  maxConsecutiveBlankLines: 1, // fold ConPTY repaint blanks (0 = drop all blank lines)
  repaintDedupe: true,         // drop ConPTY full-screen redraws before they reach the ring and log
  repaintIdleMs: 2000,         // ...but only when nothing was typed for this long (safety)
  repaintResizeMs: 3000,       // after a resize, a repeated screen is a ConPTY replay (even mid-exec)
  remoteShell: 'auto',         // sentinel dialect for ssh_exec: auto | posix | cmd | powershell
  markerMode: 'auto',          // sentinel style: auto (plain on Windows, hidden elsewhere) | plain | hidden
  markerFailThreshold: 2,      // consecutive marker timeouts before the session degrades
  degradedTimeoutMs: 15000,    // ...and then how long a command may wait
  maxToolOutputBytes: 16384,
  defaultPermission: 'ask',
  commandTimeoutMs: 120000,
  approvalTimeoutMs: 120000,
  dangerGraceMs: 5000,
  noteContextLines: 20,
  disposeGraceMs: 3000,
  defaultRows: 24,
  defaultCols: 80,
  sshBinary: 'ssh', // PATH lookup by default; override with an absolute path if needed
  extraSshArgs: [],
  dangerPatterns: [],
  dangerDisabledIds: [],
  includePromptSection: true,
};

function str(value, fallback) { return typeof value === 'string' && value.length > 0 ? value : fallback; }
function bool(value, fallback) { return typeof value === 'boolean' ? value : fallback; }
function int(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}
function strArray(value, fallback) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? [...value] : fallback;
}

/** Coerce a raw patch value into a complete settings object (unknown keys are ignored). */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {};
  const permission = ['view', 'ask', 'full'].includes(input.defaultPermission) ? input.defaultPermission : DEFAULTS.defaultPermission;
  const patterns = Array.isArray(input.dangerPatterns)
    ? input.dangerPatterns
      .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.pattern === 'string')
      .map((entry) => ({ id: String(entry.id ?? entry.pattern), pattern: entry.pattern, note: String(entry.note ?? '') }))
    : [];
  return {
    workspaceRoot: str(input.workspaceRoot, DEFAULTS.workspaceRoot),
    logDir: str(input.logDir, DEFAULTS.logDir),
    logEnabled: bool(input.logEnabled, DEFAULTS.logEnabled),
    outputLogTruncateChars: Math.max(0, int(input.outputLogTruncateChars, DEFAULTS.outputLogTruncateChars)),
    maxLogBytesPerSession: Math.max(1024, int(input.maxLogBytesPerSession, DEFAULTS.maxLogBytesPerSession)),
    logArchiveAfterDays: input.logArchiveAfterDays ?? DEFAULTS.logArchiveAfterDays,
    logRetentionDays: input.logRetentionDays ?? DEFAULTS.logRetentionDays,
    logArchiveAfterMs: (() => {
      const parsed = parseDurationMs(input.logArchiveAfterDays ?? DEFAULTS.logArchiveAfterDays, 'd');
      return parsed === null ? 7 * 86400000 : parsed;
    })(),
    logRetentionMs: (() => {
      const parsed = parseDurationMs(input.logRetentionDays ?? DEFAULTS.logRetentionDays, 'd');
      return parsed === null ? 0 : parsed;
    })(),
    maxReadBytes: Math.max(1024, int(input.maxReadBytes, DEFAULTS.maxReadBytes)),
    outputFlushQuietMs: Math.max(100, int(input.outputFlushQuietMs, DEFAULTS.outputFlushQuietMs)),
    outputIdleFlushMs: Math.max(100, int(input.outputIdleFlushMs, DEFAULTS.outputIdleFlushMs)),
    outputFlushMaxBytes: Math.max(512, int(input.outputFlushMaxBytes, DEFAULTS.outputFlushMaxBytes)),
    maxConsecutiveBlankLines: Math.max(0, int(input.maxConsecutiveBlankLines, DEFAULTS.maxConsecutiveBlankLines)),
    repaintDedupe: input.repaintDedupe !== false,
    repaintIdleMs: Math.max(0, int(input.repaintIdleMs, DEFAULTS.repaintIdleMs)),
    repaintResizeMs: Math.max(0, int(input.repaintResizeMs, DEFAULTS.repaintResizeMs)),
    remoteShell: ['auto', 'posix', 'cmd', 'powershell'].includes(input.remoteShell) ? input.remoteShell : DEFAULTS.remoteShell,
    markerMode: ['auto', 'plain', 'hidden'].includes(input.markerMode) ? input.markerMode : DEFAULTS.markerMode,
    markerFailThreshold: Math.max(1, int(input.markerFailThreshold, DEFAULTS.markerFailThreshold)),
    degradedTimeoutMs: Math.max(1000, int(input.degradedTimeoutMs, DEFAULTS.degradedTimeoutMs)),
    maxToolOutputBytes: Math.max(1024, int(input.maxToolOutputBytes, DEFAULTS.maxToolOutputBytes)),
    defaultPermission: permission,
    commandTimeoutMs: Math.max(1000, int(input.commandTimeoutMs, DEFAULTS.commandTimeoutMs)),
    approvalTimeoutMs: Math.max(1000, int(input.approvalTimeoutMs, DEFAULTS.approvalTimeoutMs)),
    dangerGraceMs: Math.max(0, int(input.dangerGraceMs, DEFAULTS.dangerGraceMs)),
    noteContextLines: Math.max(0, int(input.noteContextLines, DEFAULTS.noteContextLines)),
    disposeGraceMs: Math.max(500, int(input.disposeGraceMs, DEFAULTS.disposeGraceMs)),
    defaultRows: Math.max(5, int(input.defaultRows, DEFAULTS.defaultRows)),
    defaultCols: Math.max(20, int(input.defaultCols, DEFAULTS.defaultCols)),
    sshBinary: str(input.sshBinary, DEFAULTS.sshBinary),
    extraSshArgs: strArray(input.extraSshArgs, DEFAULTS.extraSshArgs),
    dangerPatterns: patterns,
    dangerDisabledIds: strArray(input.dangerDisabledIds, DEFAULTS.dangerDisabledIds),
    includePromptSection: bool(input.includePromptSection, DEFAULTS.includePromptSection),
  };
}

/**
 * Standard-Schema v1 shim so the row's `config` is validated and defaulted by the Loader without
 * importing a schema library.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-ssh',
    validate(value) {
      try {
        return { value: normalizeConfig(value) };
      } catch (error) {
        return { issues: [{ message: String(error?.message ?? error), path: [] }] };
      }
    },
  },
};

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** A real user-role message, shaped exactly like `createUserMessage` from the Host. */
function userMessage(text) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  });
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const hub = createHub();
  /** Workspace root: the configured override, else the first live Agent's session cwd. */
  const rootResolver = () => {
    if (config.workspaceRoot !== '') return config.workspaceRoot;
    for (const agent of ctx.agents?.list?.() ?? []) {
      const cwd = agent?.session?.header?.cwd;
      if (typeof cwd === 'string' && cwd.length > 0) return cwd;
    }
    return null;
  };
  const manager = new SshManager({
    subprocess: ctx.subprocess,
    // The provider owns PATH resolution in its execution world; a bare `ssh` becomes a real path
    // before spawning (and lands in the log), so Windows/macOS do not need a hand-written default.
    resolveExecutable: (command, signal) => ctx.subprocess.resolveExecutable?.(command, undefined, signal),
    config,
    dangerPatterns: compileDangerPatterns(config),
    rootResolver,
    emit: (frame) => hub.broadcast(frame),
  });

  /**
   * Deliver a note the operator typed in a session tab.
   * `notebook` notes never reach the model — that is the point of the third kind.
   */
  function deliverNote({ dshSessionId, sessionId, kind, text }) {
    const session = manager.get(dshSessionId, sessionId);
    const trimmed = String(text ?? '').trim();
    if (trimmed.length === 0) return { delivered: false, reason: 'empty' };
    if (kind === 'notebook') {
      session.log.append('user.note', { actor: 'user', kind, command: trimmed, text: `[仅记录] ${trimmed}`, logOnly: true });
      return { delivered: false, reason: 'log-only', message: '已写入日志，未发送给 AI' };
    }
    const isError = kind === 'error';
    const contextLines = isError && config.noteContextLines > 0 ? session.tailPlainLines(config.noteContextLines) : '';
    const body = [
      `[SSH 用户留言 · ${isError ? '报错' : '提问'} · 主机 ${session.hostLabel} · 会话 ${session.id}]`,
      trimmed,
      contextLines.length > 0 ? `\n最近终端输出（供参考）：\n${contextLines}` : '',
    ].join('\n');
    session.log.append('user.note', { actor: 'user', kind, command: trimmed, text: body, delivered: true });
    const agent = ctx.agents.get(dshSessionId);
    if (agent === undefined) {
      return { delivered: false, reason: 'no-agent', message: '该 DSH 会话当前没有运行中的 Agent；留言已写入日志，AI 下次运行时可用 ssh_log 读到' };
    }
    agent.followup(userMessage(body));
    return { delivered: true, via: 'followup' };
  }

  const diagnosticsDir = () => join(manager.root, '.dsh-ssh');
  const rpc = createSshRpc({
    manager,
    config,
    deliverNote,
    hub,
    // A browser-opened session has no Agent until it runs; once it does, its cwd decides where logs live.
    resolveCwd: (dshSessionId) => {
      const cwd = ctx.agents?.get?.(dshSessionId)?.session?.header?.cwd;
      return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
    },
    onClientError: (report) => {
      const line = `${new Date().toISOString()} ${report.scope} session=${report.sessionId ?? '-'} ${report.message}\n${report.detail}\n`;
      try {
        mkdirSync(diagnosticsDir(), { recursive: true });
        appendFileSync(join(diagnosticsDir(), 'client-errors.log'), line, 'utf8');
      } catch { /* a read-only workspace must not break the call */ }
      try { ctx.logger?.warn?.(`[dsh-ssh] client error: ${report.message}`); } catch { /* ignore */ }
    },
  });

  // 1) Model-facing surface first: the AI interface must survive a browser-side failure.
  for (const tool of createSshTools({ manager, getConfig: () => config })) {
    ctx.effect(() => ctx.tools.register(tool), `dsh-ssh:tool:${tool.name}`);
  }

  if (config.includePromptSection) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'tool:ssh',
      order: 2450,
      text: SSH_PROMPT_SECTION,
      interpolate: false,
    }), 'dsh-ssh:prompt');
  }

  // 2) Browser channels, each isolated: one failing route must not take the other with it.
  ctx.effect(() => rpc.registerInvoke(ctx), 'dsh-ssh:invoke-route');
  ctx.effect(() => rpc.registerStream(ctx), 'dsh-ssh:stream-route');

  // 3) Teardown: unload must not leave orphaned ssh processes behind.
  // Housekeeping: age out logs once at startup (delayed, so the workspace root is resolvable) and
  // after every open. Failures stay in the log directory, never break activation.
  ctx.effect(() => {
    const sweep = () => { try { manager.sweepLogs(); } catch { /* housekeeping is best-effort */ } };
    const first = setTimeout(sweep, 5000);
    // Sub-day thresholds (`12h`, `90m`) need a clock of their own: a readdir every ten minutes is
    // cheap, and gzipping only happens for files that actually aged out.
    const repeat = setInterval(sweep, 10 * 60 * 1000);
    return () => { clearTimeout(first); clearInterval(repeat); };
  }, 'dsh-ssh:log-sweep');

  ctx.effect(() => () => { void manager.closeAll('plugin unload'); }, 'dsh-ssh:teardown');

  // Diagnostics only: never let logging decide whether the plugin activates.
  try {
    ctx.logger?.info?.(`[dsh-ssh] active · logDir=${manager.logDir}`);
  } catch { /* ignore */ }
}
