/**
 * Session registry, approval queue and durable host-profile store.
 *
 * The manager is deliberately dependency-free: the plugin bundle cannot import Harness packages
 * (bare `@deepseek-ai/*` specifiers do not resolve from a profile-installed bundle), so every
 * Harness-facing shape is constructed by hand.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { detectDanger } from './danger.js';
import { archiveLogs, listLogs, readLogFile } from './log.js';
import { SshError, SshSession, SSH_ERRORS } from './session.js';

const HOSTS_FILE = 'hosts.json';

/** Simple JSON-backed store for SSH host profiles (no secrets: auth stays in local OpenSSH). */
class HostStore {
  #path;
  #profiles = [];

  constructor(root) {
    this.#path = join(root, '.dsh-ssh', HOSTS_FILE);
    try {
      if (existsSync(this.#path)) {
        const parsed = JSON.parse(readFileSync(this.#path, 'utf8'));
        if (Array.isArray(parsed?.profiles)) this.#profiles = parsed.profiles;
      }
    } catch {
      this.#profiles = [];
    }
  }

  get path() { return this.#path; }

  list() { return this.#profiles.map((profile) => ({ ...profile })); }

  save(profile) {
    const id = typeof profile?.id === 'string' && profile.id.length > 0 ? profile.id : randomUUID().slice(0, 8);
    const record = {
      id,
      name: String(profile?.name ?? profile?.target ?? id),
      target: String(profile?.target ?? ''),
      ...(profile?.user === undefined || profile.user === '' ? {} : { user: String(profile.user) }),
      ...(profile?.port === undefined || profile.port === '' ? {} : { port: Number(profile.port) }),
      ...(Array.isArray(profile?.extraArgs) ? { extraArgs: profile.extraArgs.map(String) } : {}),
      ...(profile?.note === undefined ? {} : { note: String(profile.note) }),
    };
    if (record.target.length === 0) throw new SshError('SSH_BAD_PROFILE', '主机地址不能为空');
    const index = this.#profiles.findIndex((entry) => entry.id === id);
    if (index >= 0) this.#profiles[index] = record;
    else this.#profiles.push(record);
    this.#flush();
    return record;
  }

  remove(id) {
    const before = this.#profiles.length;
    this.#profiles = this.#profiles.filter((entry) => entry.id !== id);
    this.#flush();
    return this.#profiles.length !== before;
  }

  #flush() {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      writeFileSync(this.#path, `${JSON.stringify({ profiles: this.#profiles }, null, 2)}\n`, 'utf8');
    } catch {
      // A read-only workspace must not break an otherwise working session.
    }
  }
}

export class SshManager {
  #sessions = new Map();
  #approvals = new Map();
  #emit;
  #root = null;
  #hosts = null;
  #hostsRoot = null;

  constructor({ subprocess, config, dangerPatterns, rootResolver, resolveExecutable, emit = () => {} }) {
    this.subprocess = subprocess;
    this.config = config;
    this.dangerPatterns = dangerPatterns;
    this.rootResolver = rootResolver;
    this.resolveExecutable = resolveExecutable;
    // Browser streams are filtered by DSH session, so every frame we originate must carry it.
    this.#emit = (frame) => {
      if (frame.dshSessionId === undefined && frame.sessionId !== undefined) {
        const session = this.#sessions.get(frame.sessionId);
        if (session !== undefined) emit({ ...frame, dshSessionId: session.dshSessionId });
        else emit(frame);
        return;
      }
      emit(frame);
    };
  }

  /**
   * The workspace root is resolved lazily: at activation the Harness process cwd is usually NOT the
   * session workspace, but by the time a session opens there is an Agent whose session header
   * carries the real cwd.
   */
  get root() {
    if (this.#root !== null) return this.#root;
    let resolved = null;
    try { resolved = this.rootResolver?.(); } catch { resolved = null; }
    // Cache a REAL answer only. The first caller is often the browser's `hello`, which can arrive
    // before any Agent is live; caching that fallback pinned every later session to the process cwd.
    if (typeof resolved === 'string' && resolved.length > 0) {
      this.#root = resolved;
      return resolved;
    }
    return process.cwd();
  }

  get logDir() { return join(this.root, this.config.logDir ?? '.dsh-ssh/logs'); }

  get hosts() {
    const root = this.root;
    if (this.#hosts === null || this.#hostsRoot !== root) {
      this.#hosts = new HostStore(root);
      this.#hostsRoot = root;
    }
    return this.#hosts;
  }

  list(dshSessionId) {
    // An empty id lists every session; the browser uses that only for its first snapshot, before a
    // tab has told it which DSH session it belongs to. Tools always pass the calling agent's id.
    return [...this.#sessions.values()]
      .filter((session) => dshSessionId === '' || dshSessionId === undefined || session.dshSessionId === dshSessionId)
      .map((session) => session.snapshot());
  }

  /** @throws {SshError} when the session is unknown or belongs to another DSH session. */
  get(dshSessionId, sessionId) {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) throw new SshError(SSH_ERRORS.NO_SESSION, `未知会话 ${sessionId}，请先用 ssh_list_sessions 查看`);
    if (session.dshSessionId !== dshSessionId) {
      throw new SshError(SSH_ERRORS.FOREIGN_SESSION, '该会话属于另一个 DSH 会话');
    }
    return session;
  }

  async open({ dshSessionId, target, user, port, name, rows = 24, cols = 80, permission, cwd }) {
    if (typeof target !== 'string' || target.trim().length === 0) throw new SshError('SSH_BAD_TARGET', '缺少主机地址');
    const destination = user !== undefined && user !== '' && !target.includes('@') ? `${user}@${target}` : target;
    const session = await SshSession.spawn({
      subprocess: this.subprocess,
      dshSessionId,
      target: destination,
      hostLabel: name ?? destination,
      sshBinary: this.config.sshBinary ?? 'ssh',
      resolveExecutable: this.resolveExecutable,
      extraArgs: Array.isArray(this.config.extraSshArgs) ? this.config.extraSshArgs : [],
      port,
      cwd: cwd ?? this.root,
      rows,
      cols,
      graceMs: this.config.disposeGraceMs ?? 3000,
      timeoutMs: this.config.commandTimeoutMs ?? 120000,
      permission: permission ?? this.config.defaultPermission ?? 'ask',
      dangerPatterns: this.dangerPatterns,
      // Logs belong under the owning session's workspace; the process cwd is only the last resort.
      logDir: join(cwd !== undefined && cwd.length > 0 ? cwd : this.root, this.config.logDir ?? '.dsh-ssh/logs'),
      logEnabled: this.config.logEnabled !== false,
      outputTruncateChars: this.config.outputLogTruncateChars ?? 200,
      outputFlushQuietMs: this.config.outputFlushQuietMs,
      outputIdleFlushMs: this.config.outputIdleFlushMs,
      outputFlushMaxBytes: this.config.outputFlushMaxBytes,
      maxConsecutiveBlankLines: this.config.maxConsecutiveBlankLines,
      repaintDedupe: this.config.repaintDedupe,
      repaintIdleMs: this.config.repaintIdleMs,
      repaintResizeMs: this.config.repaintResizeMs,
      remoteShell: this.config.remoteShell,
      markerMode: this.config.markerMode,
      markerFailThreshold: this.config.markerFailThreshold,
      degradedTimeoutMs: this.config.degradedTimeoutMs,
      maxLogBytes: this.config.maxLogBytesPerSession ?? 8 * 1024 * 1024,
      emit: (frame) => this.#emit(frame),
    });
    this.#sessions.set(session.id, session);
    this.#emit({ t: 'opened', dshSessionId, session: session.snapshot() });
    return session.snapshot();
  }

  async close(dshSessionId, sessionId) {
    const session = this.get(dshSessionId, sessionId);
    this.#resolveApprovalsFor(sessionId, { approved: false, by: 'closed' });
    await session.close('user closed');
    this.#sessions.delete(sessionId);
    return { sessionId, closed: true };
  }

  async closeAll(reason = 'plugin unload') {
    for (const session of [...this.#sessions.values()]) {
      this.#resolveApprovalsFor(session.id, { approved: false, by: 'closed' });
      try { await session.close(reason); } catch { /* best effort */ }
      this.#sessions.delete(session.id);
    }
  }

  setPermission(dshSessionId, sessionId, permission) {
    return this.get(dshSessionId, sessionId).setPermission(permission, 'user');
  }

  rename(dshSessionId, sessionId, name) {
    const session = this.get(dshSessionId, sessionId);
    session.hostLabel = String(name);
    this.#emit({ t: 'state', session: session.snapshot() });
    return session.snapshot();
  }

  async resize(dshSessionId, sessionId, cols, rows) {
    const session = this.get(dshSessionId, sessionId);
    await session.resize(cols, rows);
    return session.snapshot();
  }

  async writeUser(dshSessionId, sessionId, data) {
    const session = this.get(dshSessionId, sessionId);
    await session.write(data, { actor: 'user', reason: 'keystroke' });
    return { ok: true };
  }

  revokeAi(dshSessionId, sessionId) {
    const session = this.get(dshSessionId, sessionId);
    return { revoked: session.revokeAi('user reclaimed control') };
  }

  /**
   * Age out finished logs and honour the retention window. Live sessions are protected: their files
   * are still being appended to, so they must not be moved or gzipped.
   */
  sweepLogs(now = Date.now()) {
    const protect = [...this.#sessions.values()]
      .map((session) => session.logPath)
      .filter((path) => typeof path === 'string' && path.length > 0);
    return archiveLogs({
      dir: this.logDir,
      protect,
      archiveAfterMs: this.config.logArchiveAfterMs,
      retentionMs: this.config.logRetentionMs,
      now,
    });
  }

  /** Every log file on disk, current or archived, newest first — history, not just this session. */
  listLogs(limit) {
    return listLogs({
      dir: this.logDir,
      limit,
      archiveAfterMs: this.config.logArchiveAfterMs,
      retentionMs: this.config.logRetentionMs,
    });
  }

  /** Read one log file's tail by name; the name is validated inside `readLogFile`. */
  readLogFile(name, maxLines) {
    return readLogFile({ dir: this.logDir, name, maxLines, maxBytes: this.config.maxReadBytes });
  }

  logRead(dshSessionId, sessionId, { actor, kind, limit = 200 } = {}) {
    const session = this.get(dshSessionId, sessionId);
    return { path: session.logPath, entries: session.entries({ actor, kind, limit }) };
  }

  /**
   * Ask the operator to approve one AI command (or to keep a dangerous one from running).
   * `mode: 'announce'` proceeds unless the operator cancels inside the grace window.
   */
  requestApproval(session, { command, danger, mode, timeoutMs }) {
    const approvalId = randomUUID().slice(0, 8);
    const expiresAt = Date.now() + timeoutMs;
    session.log.append('ai.pending', {
      actor: 'ai',
      command,
      mode,
      danger: danger?.id,
      pattern: danger?.match,
    });
    this.#emit({
      t: 'approval',
      sessionId: session.id,
      approval: { id: approvalId, command, mode, danger, expiresAt, graceMs: timeoutMs },
    });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#approvals.delete(approvalId);
        const approved = mode === 'announce';
        session.log.append(approved ? 'ai.approved' : 'ai.denied', { actor: 'system', command, by: 'timeout' });
        this.#emit({ t: 'approval-resolved', sessionId: session.id, approvalId, approved, by: 'timeout' });
        resolve({ approved, by: 'timeout' });
      }, Math.max(250, timeoutMs));
      timer.unref?.();
      this.#approvals.set(approvalId, {
        approvalId,
        sessionId: session.id,
        command,
        mode,
        danger,
        resolve: (outcome) => {
          clearTimeout(timer);
          this.#approvals.delete(approvalId);
          resolve(outcome);
        },
      });
    });
  }

  answerApproval(dshSessionId, sessionId, approvalId, approve) {
    const pending = this.#approvals.get(approvalId);
    if (pending === undefined || pending.sessionId !== sessionId) {
      throw new SshError('SSH_NO_APPROVAL', '该确认请求已失效');
    }
    const session = this.get(dshSessionId, sessionId);
    const by = approve ? 'user' : pending.mode === 'announce' ? 'user-cancel' : 'user-deny';
    session.log.append(approve ? 'ai.approved' : 'ai.denied', { actor: 'user', command: pending.command, by });
    this.#emit({ t: 'approval-resolved', sessionId, approvalId, approved: approve, by });
    pending.resolve({ approved: approve, by });
    return { approvalId, approved: approve, by };
  }

  #resolveApprovalsFor(sessionId, outcome) {
    for (const pending of [...this.#approvals.values()]) {
      if (pending.sessionId !== sessionId) continue;
      pending.resolve(outcome);
    }
  }

  /**
   * The single AI write path: permission gate, danger gate, then one marked command on the shared PTY.
   */
  async execByAi(dshSessionId, sessionId, command, { timeoutMs } = {}) {
    const session = this.get(dshSessionId, sessionId);
    if (session.permission === 'view') {
      session.log.append('ai.blocked', { actor: 'ai', code: SSH_ERRORS.PERMISSION_VIEW_ONLY, command });
      throw new SshError(
        SSH_ERRORS.PERMISSION_VIEW_ONLY,
        '当前权限为「仅可看」，AI 不能执行命令。请让用户在 SSH 会话工具栏把权限切成「问答」或「完全」。',
      );
    }
    const danger = detectDanger(command, this.dangerPatterns);
    if (session.permission === 'ask') {
      const outcome = await this.requestApproval(session, {
        command,
        danger,
        mode: 'approve',
        timeoutMs: this.config.approvalTimeoutMs ?? 120000,
      });
      if (!outcome.approved) {
        const code = outcome.by === 'timeout' ? SSH_ERRORS.APPROVAL_TIMEOUT : SSH_ERRORS.APPROVAL_DENIED;
        const message = outcome.by === 'timeout' ? '用户未在超时前确认，命令未执行' : '用户拒绝执行该命令';
        throw new SshError(code, message);
      }
    } else if (danger !== null) {
      // `full` permission still announces a dangerous command before it runs, with a cancel window.
      const announced = await this.requestApproval(session, {
        command,
        danger,
        mode: 'announce',
        timeoutMs: this.config.dangerGraceMs ?? 5000,
      });
      if (!announced.approved) {
        session.log.append('ai.denied', { actor: 'user', command, by: 'danger-cancel', danger: danger.id });
        throw new SshError('SSH_DANGER_CANCELLED', '用户在危险命令执行前取消了它');
      }
    }
    const result = await session.run(command, { timeoutMs, actor: 'ai' });
    return { ...result, danger, permission: session.permission, sessionId: session.id };
  }

  async sendRaw(dshSessionId, sessionId, text, submit) {
    const session = this.get(dshSessionId, sessionId);
    if (session.permission === 'view') {
      throw new SshError(SSH_ERRORS.PERMISSION_VIEW_ONLY, '当前权限为「仅可看」，AI 不能写入会话');
    }
    if (session.permission === 'ask') {
      const outcome = await this.requestApproval(session, {
        command: submit ? text : `${text}（不回车）`,
        danger: detectDanger(text, this.dangerPatterns),
        mode: 'approve',
        timeoutMs: this.config.approvalTimeoutMs ?? 120000,
      });
      if (!outcome.approved) throw new SshError(SSH_ERRORS.APPROVAL_DENIED, '用户拒绝该写入');
    }
    await session.write(submit ? `${text}\r` : text, { actor: 'ai', reason: 'ssh_send' });
    return { ok: true, sessionId: session.id };
  }
}
