/**
 * One SSH session = one real PTY running the local OpenSSH client.
 *
 * The operator and the AI share this single interactive channel: keystrokes, injected commands
 * and the program's output all travel through the same PTY, so everything either side does is
 * visible to the other side and lands in the session log.
 */

import { createHash } from 'node:crypto';

import { OutputRing, plainText, projectOutput } from './ring.js';
import { SessionLog } from './log.js';
import {
  createMarker,
  looksLikeSecretPrompt,
  markedInput,
  parseMarker,
  stripEcho,
  stripMarkers,
} from './exec.js';

export const PERMISSIONS = ['view', 'ask', 'full'];

/** Error codes that callers and the model can route on. */
export const SSH_ERRORS = {
  NO_SESSION: 'SSH_NO_SESSION',
  FOREIGN_SESSION: 'SSH_FOREIGN_SESSION',
  SESSION_EXITED: 'SSH_SESSION_EXITED',
  PERMISSION_VIEW_ONLY: 'SSH_PERMISSION_VIEW_ONLY',
  APPROVAL_REQUIRED: 'SSH_APPROVAL_REQUIRED',
  APPROVAL_DENIED: 'SSH_APPROVAL_DENIED',
  APPROVAL_TIMEOUT: 'SSH_APPROVAL_TIMEOUT',
  SEND_ACTIVE: 'SSH_SEND_ACTIVE',
  INPUT_REVOKED: 'SSH_INPUT_REVOKED',
  AUTH_REQUIRED: 'SSH_AUTH_REQUIRED',
  SPAWN_FAILED: 'SSH_SPAWN_FAILED',
};

export class SshError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'SshError';
    this.code = code;
    this.details = details;
  }
}

let nextSessionNumber = 0;

export class SshSession {
  #ring = new OutputRing({ maxBytes: 4 * 1024 * 1024 });
  #handle;
  #log;
  #emit;
  #dangerPatterns;
  #unsubscribeRing = null;
  #readyLogged = false;
  #lastOutputAt = 0;
  #userLine = '';
  #lastUserInputAt = 0;
  #lastInputAt = 0;
  #lastFrame = null;
  #frameHistory = [];
  #resizeAt = 0;
  #repaintDedupe;
  #repaintIdleMs;
  #repaintResizeMs;
  #markerFailThreshold;
  #degradedTimeoutMs;
  #revokedSource = null;
  #pendingRepaints = 0;
  #pendingRepaintBytes = 0;
  #pendingRepaintOf = null;
  #maxBlankLines;
  #closed = false;
  #outBuf = '';
  #outTimer = null;
  #outputFlushQuietMs;
  #outputIdleFlushMs;
  #outputFlushMaxBytes;

  constructor(options) {
    this.id = options.id;
    this.dshSessionId = options.dshSessionId;
    this.target = options.target;
    this.hostLabel = options.hostLabel;
    this.sshBinary = options.sshBinary;
    this.extraArgs = options.extraArgs ?? [];
    this.user = options.user;
    this.port = options.port;
    this.cwd = options.cwd;
    this.rows = options.rows ?? 24;
    this.cols = options.cols ?? 80;
    this.graceMs = options.graceMs ?? 3000;
    this.timeoutMs = options.timeoutMs ?? 120000;
    this.resolveExecutable = options.resolveExecutable;
    // The durable log records ONE entry per interaction; the live browser stream is unaffected.
    this.#outputFlushQuietMs = Math.max(100, options.outputFlushQuietMs ?? 400);
    this.#outputIdleFlushMs = Math.max(this.#outputFlushQuietMs, options.outputIdleFlushMs ?? 5000);
    this.#outputFlushMaxBytes = Math.max(512, options.outputFlushMaxBytes ?? 8192);
    // Windows ConPTY redraws its whole visible buffer on its own schedule; those frames are pure
    // noise. Deduplication only applies while the session is idle (no input for `repaintIdleMs`),
    // because output that arrives while nothing was typed cannot be new information.
    this.#repaintDedupe = options.repaintDedupe !== false;
    this.#repaintIdleMs = Math.max(0, options.repaintIdleMs ?? 2000);
    // How long after a resize a repeated screen is treated as a ConPTY replay.
    this.#repaintResizeMs = Math.max(0, options.repaintResizeMs ?? 3000);
    this.#maxBlankLines = Math.max(0, options.maxConsecutiveBlankLines ?? 1);
    this.repaintsSkipped = 0;
    this.repaintBytesSaved = 0;
    this.resizeDuplicates = 0;
    this.remoteShell = options.remoteShell ?? 'auto';
    // Marker style. `plain` prints the sentinel instead of concealing it and erasing the line: on
    // ConPTY a line that is printed and erased inside one render frame produces NO output bytes, so
    // the hidden form is unobservable there (measured on Windows 10; concealment itself is harmless).
    const requestedMode = options.markerMode ?? 'auto';
    this.markerMode = requestedMode === 'auto' ? (process.platform === 'win32' ? 'plain' : 'hidden') : requestedMode;
    this.markerFailures = 0;
    this.markerUnavailable = false;
    this.#markerFailThreshold = Math.max(1, options.markerFailThreshold ?? 2);
    this.#degradedTimeoutMs = Math.max(1000, options.degradedTimeoutMs ?? 15000);
    this.detectedShell = this.remoteShell === 'auto' ? 'unknown' : this.remoteShell;
    this.permission = options.permission ?? 'ask';
    this.state = 'connecting';
    this.exitCode = null;
    this.exitSignal = null;
    this.inputOwner = 'user';
    this.aiBusy = false;
    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.secretPending = false;
    this.activeExec = null;
    const rawEmit = options.emit ?? (() => {});
    // Every frame carries its DSH session so one stream can serve all tabs of that session.
    this.#emit = (frame) => rawEmit({ ...frame, dshSessionId: this.dshSessionId });
    this.#dangerPatterns = options.dangerPatterns ?? [];
    this.#log = new SessionLog({
      dir: options.logDir,
      sessionId: this.id,
      hostLabel: this.hostLabel,
      enabled: options.logEnabled !== false,
      outputTruncateChars: options.outputTruncateChars,
      maxBytes: options.maxLogBytes,
    });
  }

  get logPath() { return this.#log.filePath; }
  get ring() { return this.#ring; }
  /** The session's durable log, used by the manager for approvals and audited events. */
  get log() { return this.#log; }
  /** In-memory log tail (filtered), for tools and the log drawer. */
  entries(options) { return this.#log.entries(options); }
  get alive() { return !this.#closed && (this.state === 'connecting' || this.state === 'ready'); }

  /** Human- and model-readable summary. */
  snapshot() {
    return {
      id: this.id,
      host: this.hostLabel,
      target: this.target,
      state: this.state,
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      permission: this.permission,
      inputOwner: this.inputOwner,
      aiBusy: this.aiBusy,
      secretPending: this.secretPending,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      // ConPTY diagnostics: how much of `bytesOut` was folded away as repaint/noise.
      visibleBytes: Math.max(0, this.bytesOut - this.repaintBytesSaved),
      repaintsSkipped: this.repaintsSkipped,
      repaintBytesSaved: this.repaintBytesSaved,
      lastResizeAt: this.#resizeAt === 0 ? null : this.#resizeAt,
      resizeDuplicates: this.resizeDuplicates,
      detectedShell: this.detectedShell,
      markerMode: this.markerMode,
      markerUnavailable: this.markerUnavailable,
      logPath: this.logPath,
    };
  }

  /**
   * Start the ssh client inside a real PTY.
   * @param {object} options see the constructor plus `subprocess` (ctx.subprocess)
   * @returns {Promise<SshSession>}
   */
  static async spawn(options) {
    nextSessionNumber += 1;
    const id = options.id ?? `ssh-${nextSessionNumber}`;
    const session = new SshSession({ ...options, id });
    await session.#start(options.subprocess, options.signal);
    return session;
  }

  /** A bare name goes through the provider's PATH lookup; an explicit path is used verbatim. */
  async #resolveBinary(signal) {
    const configured = this.sshBinary;
    if (typeof configured !== 'string' || configured.length === 0) return 'ssh';
    if (configured.includes('/') || configured.includes('\\')) return configured;
    try {
      const resolved = await this.resolveExecutable?.(configured, signal);
      if (typeof resolved === 'string' && resolved.length > 0) return resolved;
    } catch { /* fall through: execvp resolves a bare name at spawn time anyway */ }
    return configured;
  }

  async #start(subprocess, signal) {
    const binary = await this.#resolveBinary(signal);
    const argv = [binary, '-tt'];
    if (this.port !== undefined && this.port !== null && this.port !== 22) argv.push('-p', String(this.port));
    argv.push(...this.extraArgs, this.target);
    this.argv = argv;
    this.#log.append('session.open', {
      actor: 'system',
      command: argv.join(' '),
      dshSession: this.dshSessionId,
      cwd: this.cwd,
    });
    let handle;
    try {
      handle = await subprocess.spawnTerminal({
        argv,
        cwd: this.cwd,
        rows: this.rows,
        cols: this.cols,
        terminalType: 'xterm-256color',
        shellActivity: false,
        graceMs: this.graceMs,
        signal,
      });
    } catch (error) {
      this.state = 'exited';
      this.#log.append('error', { actor: 'system', code: SSH_ERRORS.SPAWN_FAILED, text: String(error?.message ?? error) });
      await this.#log.close();
      throw new SshError(
        SSH_ERRORS.SPAWN_FAILED,
        `无法启动 ssh（${this.sshBinary}）：${error?.message ?? error}。`
        + '请确认本机装了 OpenSSH 客户端（Linux/macOS 通常 /usr/bin/ssh，'
        + 'Windows 通常 C:\\Windows\\System32\\OpenSSH\\ssh.exe），或用配置项 sshBinary 指定绝对路径。',
      );
    }
    this.#handle = handle;
    this.pid = handle.pid;
    this.#unsubscribeRing = this.#ring.subscribe((record) => {
      this.#emit({ t: 'output', sessionId: this.id, seq: record.seq, data: record.data });
    });
    handle.output.setEncoding?.('utf8');
    handle.output.on('data', (chunk) => this.#onOutput(String(chunk)));
    handle.done.then(
      (outcome) => this.#onExit(outcome?.exitCode ?? null, outcome?.signal ?? null),
      (error) => {
        this.#log.append('error', { actor: 'system', code: 'SSH_PTY_FAILED', text: String(error?.message ?? error) });
        this.#onExit(null, null);
      },
    );
    this.#emit({ t: 'state', session: this.snapshot() });
    return this;
  }

  /**
   * The repaint rule, as a pure function so its contract is testable without a PTY.
   *
   * A frame is a repaint only when the session is idle (nothing typed for `idleMs`), nothing is
   * executing, and the frame is a large, multi-line, byte-identical repetition of the previous one.
   * The idle requirement is what keeps it safe: output that arrives right after input is never a
   * repaint, so `echo hi; echo hi` is preserved.
   */
  static repaintDecision({
    dedupe, state, activeExec, sinceInputMs, idleMs, previousFingerprint, fingerprint, bytes, lines,
    recentResize = false, previousFingerprints = [],
  }) {
    if (dedupe !== true) return false;
    if (state !== 'ready') return false;
    if (bytes < 128) return false;
    if (lines < 4) return false;
    if (typeof fingerprint !== 'string' || fingerprint.length === 0) return false;
    const repeats = previousFingerprints.includes(fingerprint);
    // A resize makes ConPTY repaint the screen, and that replay arrives even while a command runs.
    // The idle gate must not apply here: the replay carries OLD sentinel lines, and letting them into
    // the exec capture is exactly how a stale exit code and polluted output got through.
    if (recentResize && repeats) return true;
    // Otherwise: never deduplicate while a command is running, and only when nothing was typed for a
    // while, so legitimate repeated output (`echo hi; echo hi`, `tail -f`) is preserved.
    if (activeExec === true) return false;
    if (sinceInputMs < idleMs) return false;
    if (typeof previousFingerprint !== 'string' || previousFingerprint.length === 0) return false;
    return previousFingerprint === fingerprint;
  }

  /** Prompt-shape detection for the sentinel dialect; never overrides an explicit setting. */
  static detectShell(current, text) {
    if (current === 'cmd' || current === 'powershell') return current;
    const tail = plainText(text).slice(-600);
    if (/PS\s+[A-Za-z]:\\[^>]*>/.test(tail)) return 'powershell';
    if (/Microsoft Windows \[|cmd\.exe|%COMSPEC%/i.test(tail)) return 'cmd';
    if (/[$#]\s*$/.test(tail.trimEnd())) return 'posix';
    return current;
  }

  /** The sentinel dialect to use: an explicit setting, else what the prompt shape told us. */
  shellDialect() {
    if (this.remoteShell !== undefined && this.remoteShell !== 'auto') return this.remoteShell;
    return this.detectedShell === 'cmd' || this.detectedShell === 'powershell' ? this.detectedShell : 'posix';
  }

  #isRepaint(chunk) {
    const bytes = Buffer.byteLength(chunk, 'utf8');
    const projected = plainText(chunk, { maxConsecutiveBlankLines: 0 });
    const visible = projected.replace(/\s+/g, ' ').trim();
    const fingerprint = visible.length === 0 ? null : createHash('sha1').update(visible).digest('hex');
    const repaint = SshSession.repaintDecision({
      dedupe: this.#repaintDedupe,
      state: this.state,
      activeExec: this.activeExec !== null,
      sinceInputMs: this.#lastInputAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - this.#lastInputAt,
      idleMs: this.#repaintIdleMs,
      previousFingerprint: this.#lastFrame === null ? null : this.#lastFrame.fingerprint,
      previousFingerprints: this.#frameHistory,
      recentResize: this.#resizeAt !== 0 && Date.now() - this.#resizeAt < this.#repaintResizeMs,
      fingerprint,
      bytes,
      lines: projected.length === 0 ? 0 : projected.split('\n').length,
    });
    if (repaint) {
      this.repaintsSkipped += 1;
      this.repaintBytesSaved += bytes;
      this.#pendingRepaints += 1;
      this.#pendingRepaintBytes += bytes;
      this.#pendingRepaintOf = this.#lastFrame.seq;
      return true;
    }
    if (fingerprint !== null) {
      this.#lastFrame = { fingerprint, seq: this.#ring.seq + 1 };
      // Remember a short history, not just the previous frame: a replay repeats an OLDER screen.
      if (!this.#frameHistory.includes(fingerprint)) {
        this.#frameHistory.push(fingerprint);
        if (this.#frameHistory.length > 8) this.#frameHistory.shift();
      }
    }
    return false;
  }

  #onOutput(chunk) {
    if (chunk.length === 0) return;
    this.bytesOut += Buffer.byteLength(chunk, 'utf8');
    const repaint = this.#isRepaint(chunk);
    if (!repaint) this.#ring.append(chunk);
    this.detectedShell = SshSession.detectShell(this.detectedShell, chunk);
    this.lastActivityAt = Date.now();
    this.#lastOutputAt = this.lastActivityAt;
    if (!this.#readyLogged && chunk.trim().length > 0) {
      this.#readyLogged = true;
      if (this.state === 'connecting') {
        this.state = 'ready';
        this.#log.append('session.ready', { actor: 'system' });
        this.#emit({ t: 'state', session: this.snapshot() });
      }
    }
    const secret = looksLikeSecretPrompt(this.#ring.tailText(400));
    if (secret !== this.secretPending) {
      this.secretPending = secret;
      this.#emit({ t: 'state', session: this.snapshot() });
    }
    this.#coalesceOutput(chunk, repaint);
  }

  /**
   * Output reaches the log coalesced rather than chunk by chunk: one entry per quiet period or
   * per ~4 KiB, so the JSONL stays readable while the byte stream itself stays lossless on the
   * live channel.
   */
  /**
   * The operator typed within this window, so the terminal is drawing an editable line.
   * Arrow keys, history recall and completion produce no line text but still mean "hands on the
   * keyboard", which is why this is a timestamp rather than a check of the pending line buffer.
   */
  #typingRecently() {
    return this.#lastUserInputAt !== 0 && Date.now() - this.#lastUserInputAt < 30000;
  }

  #coalesceOutput(chunk, repaint = false) {
    // A deduplicated frame is not buffered at all: it would only add bytes to the next log entry.
    if (repaint) return;
    this.#outBuf += chunk;
    if (Buffer.byteLength(this.#outBuf, 'utf8') >= this.#outputFlushMaxBytes) { this.#flushOutput(); return; }
    if (this.#outTimer !== null) clearTimeout(this.#outTimer);

    // Real output ended a line: log it soon.
    if (this.#outBuf.includes('\n')) {
      this.#outTimer = setTimeout(() => this.#flushOutput(), this.#outputFlushQuietMs);
      return;
    }
    // A newline-less buffer while the operator is typing is the terminal REDRAWING the line being
    // edited (readline repaints it on every keystroke). No timer at all: hold it until Enter, the
    // size cap, or session end. Any time-based window splits the line as soon as someone pauses
    // longer than it — which is exactly what happened with `ls` … 10s … ` -a`.
    if (this.#typingRecently()) return;
    // Nobody is typing and there is still no newline: a bare prompt (or progress output). Let it
    // settle, then log it.
    this.#outTimer = setTimeout(() => this.#flushOutput(), this.#outputIdleFlushMs);
  }

  #flushOutput() {
    if (this.#outTimer !== null) { clearTimeout(this.#outTimer); this.#outTimer = null; }
    const raw = this.#outBuf;
    const repaints = this.#pendingRepaints;
    const repaintBytes = this.#pendingRepaintBytes;
    const repaintOf = this.#pendingRepaintOf;
    this.#outBuf = '';
    this.#pendingRepaints = 0;
    this.#pendingRepaintBytes = 0;
    this.#pendingRepaintOf = null;
    if (raw.length === 0) return;
    const projection = projectOutput(stripMarkers(raw), { maxConsecutiveBlankLines: this.#maxBlankLines });
    this.#log.append('output', {
      actor: 'remote',
      text: projection.text,
      // Accounting, so a ConPTY session's noise level stays measurable from the log alone.
      rawBytes: projection.rawBytes,
      collapsedBytes: projection.collapsedBytes,
      blankLines: projection.blankLines,
      rewrites: projection.rewrites,
      repaintsSkipped: repaints > 0 ? repaints : undefined,
      repaintBytes: repaints > 0 ? repaintBytes : undefined,
      repaintOf: repaintOf === null ? undefined : repaintOf,
    });
    this.#emit({ t: 'log', sessionId: this.id, entry: this.#log.entries({ limit: 1 })[0] });
  }

  #onExit(exitCode, signal) {
    if (this.#closed && this.state === 'exited') return;
    this.state = 'exited';
    this.exitCode = exitCode;
    this.exitSignal = signal ?? null;
    this.#flushOutput();
    this.#log.append('session.exit', { actor: 'system', exitCode, signal: signal ?? null });
    const pending = this.activeExec;
    if (pending !== null) pending.settle({ waitReason: 'session_exit', exitCode, output: '' });
    this.#emit({ t: 'state', session: this.snapshot() });
    void this.#log.close();
  }

  /** Plain-text tail, used for tool results, notes and the UI banner. */
  banner(maxChars = 2000) {
    return plainText(this.#ring.all()).slice(0, maxChars).trim();
  }

  read({ offset = 0, count = 500 } = {}) {
    const page = this.#ring.readLines({ offset, count });
    return { ...page, text: stripMarkers(plainText(page.text)) };
  }

  tailPlainLines(lines) {
    return stripMarkers(this.#ring.tailPlainLines(lines));
  }

  setPermission(permission, actor = 'user') {
    if (!PERMISSIONS.includes(permission)) throw new SshError('SSH_BAD_PERMISSION', `未知权限: ${permission}`);
    const previous = this.permission;
    this.permission = permission;
    this.#log.append('permission.change', { actor, from: previous, to: permission });
    this.#emit({ t: 'state', session: this.snapshot() });
    return this.snapshot();
  }

  setInputOwner(owner, reason = '') {
    if (this.inputOwner === owner) return;
    this.inputOwner = owner;
    this.#log.append('input.owner', { actor: 'system', owner, reason });
    this.#emit({ t: 'state', session: this.snapshot() });
  }

  #assertWritable() {
    if (!this.alive) throw new SshError(SSH_ERRORS.SESSION_EXITED, '会话已结束，请重新连接');
  }

  /** Write raw bytes into the PTY (user keystrokes, AI `ssh_send`, control characters). */
  async write(data, { actor = 'user', reason = '' } = {}) {
    this.#assertWritable();
    if (actor === 'ai' && this.permission === 'view') {
      throw new SshError(SSH_ERRORS.PERMISSION_VIEW_ONLY, '当前权限为「仅可看」，AI 不能写入；请让用户在会话工具栏切换权限');
    }
    if (actor === 'ai' && this.secretPending) {
      this.#log.append('ai.blocked', { actor: 'ai', code: SSH_ERRORS.AUTH_REQUIRED, text: data });
      throw new SshError(SSH_ERRORS.AUTH_REQUIRED, '远端正在等待认证输入，AI 不得代填凭据');
    }
    await this.#handle.write(data);
    this.bytesIn += Buffer.byteLength(data, 'utf8');
    this.lastActivityAt = Date.now();
    this.#lastInputAt = this.lastActivityAt;
    if (actor === 'user') {
      this.#lastUserInputAt = Date.now();
      // A human keystroke reclaims control from the AI, exactly like typing over a shared session.
      if (this.inputOwner === 'ai') {
        this.setInputOwner('user', 'user keystroke');
        const active = this.activeExec;
        if (active !== null) { this.#revokedSource = 'user keystroke'; active.settle({ waitReason: 'revoked', output: '' }); }
      }
      this.#trackUserLine(data);
    }
    return { ok: true };
  }

  /** Log human input line by line, redacting anything typed at a credential prompt. */
  #trackUserLine(data) {
    if (data.includes('\u0003')) {
      this.#log.append('user.input', { actor: 'user', text: '^C', command: '^C' });
    }
    for (const char of data) {
      if (char === '\r' || char === '\n') {
        const line = this.#userLine;
        this.#userLine = '';
        if (line.length === 0) continue;
        const sensitive = looksLikeSecretPrompt(this.#ring.tailText(400)) || this.secretPending;
        this.#log.append('user.input', {
          actor: 'user',
          command: sensitive ? '[redacted]' : line,
          text: sensitive ? '[redacted]' : line,
          sensitive: sensitive || undefined,
        });
        // Submitting a line closes the interaction: the echoed prompt/line becomes its own entry,
        // so the log reads "user typed X" followed by "terminal showed Y".
        this.#flushOutput();
      } else if (char === '\u007f' || char === '\b') {
        this.#userLine = this.#userLine.slice(0, -1);
      } else if (char >= ' ') {
        this.#userLine += char;
      }
    }
  }

  async resize(cols, rows, { source = 'client' } = {}) {
    if (this.#handle === undefined) return false;
    const next = [Math.max(1, Math.floor(Number(cols) || 80)), Math.max(1, Math.floor(Number(rows) || 24))];
    // A ConPTY session repaints the whole screen on a resize, so knowing whether the size actually
    // changed (and who sent it) is the difference between "our client did it" and "the PTY did it".
    if (next[0] === this.cols && next[1] === this.rows) {
      this.resizeDuplicates += 1;
      return false;
    }
    this.cols = next[0];
    this.rows = next[1];
    this.#resizeAt = Date.now();
    await this.#handle.resize(next[0], next[1]);
    this.#log.append('session.resize', {
      actor: 'system',
      cols: next[0],
      rows: next[1],
      source,
      duplicates: this.resizeDuplicates > 0 ? this.resizeDuplicates : undefined,
    });
    this.resizeDuplicates = 0;
    return true;
  }

  async signal(signal) {
    this.#assertWritable();
    const targetPgid = await this.#handle.signalForeground(signal);
    this.#log.append('signal', { actor: 'ai', signal, targetPgid });
    return { delivered: true, targetPgid };
  }

  /**
   * Run one command on the shared shell and wait for the sentinel marker.
   * The caller owns permission checks and approval; this method owns the input token and the wait.
   */
  async run(command, { actor = 'ai', timeoutMs, holdInput = true } = {}) {
    this.#assertWritable();
    if (this.activeExec !== null) throw new SshError(SSH_ERRORS.SEND_ACTIVE, '该会话已有命令在执行');
    if (this.secretPending) throw new SshError(SSH_ERRORS.AUTH_REQUIRED, '远端正在等待认证输入，AI 不得代填凭据');
    const marker = createMarker();
    // After `markerFailThreshold` timeouts the sentinel is demonstrably unobservable in this session
    // (a PTY that swallows it, an exotic remote shell): stop making the caller wait the full timeout
    // and say so, so the AI can switch to ssh_send + ssh_read.
    const effectiveTimeout = this.markerUnavailable
      ? Math.min(timeoutMs ?? this.timeoutMs, this.#degradedTimeoutMs)
      : (timeoutMs ?? this.timeoutMs);
    const deadline = Date.now() + effectiveTimeout;
    const startSeq = this.#ring.seq;
    if (holdInput) this.setInputOwner('ai', 'exec');
    this.#log.append('ai.command', { actor, command, marker });
    this.#emit({ t: 'annotate', sessionId: this.id, annotation: { kind: 'ai-command', command, at: Date.now() } });

    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    const operation = {
      marker,
      settle: (outcome) => {
        if (operation.settled) return;
        operation.settled = true;
        if (this.activeExec === operation) this.activeExec = null;
        if (holdInput && this.inputOwner === 'ai') this.setInputOwner('user', 'exec settled');
        const raw = this.#ring.since(startSeq);
        const parsed = parseMarker(raw, marker);
        const exitCode = outcome?.exitCode ?? parsed?.exitCode ?? null;
        const output = stripEcho(raw, { command, marker, shell: this.shellDialect(), markerMode: this.markerMode });
        const waitReason = outcome?.waitReason ?? (parsed !== null ? 'marker' : 'unknown');
        if (waitReason === 'marker') {
          this.markerFailures = 0;
          this.markerUnavailable = false;
        } else if (waitReason === 'timeout') {
          this.markerFailures += 1;
          if (this.markerFailures >= this.#markerFailThreshold) this.markerUnavailable = true;
        }
        if (waitReason === 'revoked') {
          try { this.#handle.write('\u0003'); } catch { /* the PTY may already be gone */ }
        }
        this.aiBusy = false;
        this.#log.append('ai.result', {
          actor,
          command,
          text: output,
          exitCode,
          waitReason,
          markerUnavailable: this.markerUnavailable,
          markerMode: this.markerMode,
          revokedSource: waitReason === 'revoked' ? this.#revokedSource : undefined,
          danger: outcome?.danger,
        });
        this.#emit({ t: 'state', session: this.snapshot() });
        settle({ output, exitCode, waitReason, truncated: output.length > 8000, danger: outcome?.danger });
      },
      settled: false,
    };
    this.activeExec = operation;
    this.aiBusy = true;
    this.#emit({ t: 'state', session: this.snapshot() });

    const timer = setTimeout(() => operation.settle({ waitReason: 'timeout' }), Math.max(1000, deadline - Date.now()));
    const waiter = this.#ring.subscribe(() => {
      const parsed = parseMarker(this.#ring.since(startSeq), marker);
      if (parsed !== null) {
        clearTimeout(timer);
        operation.settle({ waitReason: 'marker', exitCode: parsed.exitCode });
      }
    });
    try {
      await this.#handle.write(markedInput(command, marker, this.shellDialect(), { markerMode: this.markerMode }));
      this.bytesIn += Buffer.byteLength(command, 'utf8');
      this.lastActivityAt = Date.now();
    } catch (error) {
      clearTimeout(timer);
      waiter();
      operation.settle({ waitReason: 'write_failed' });
      throw new SshError(SSH_ERRORS.SESSION_EXITED, `写入失败: ${error?.message ?? error}`);
    }
    const result = await done;
    waiter();
    clearTimeout(timer);
    return result;
  }

  /** Interrupt whatever the AI is running (used when the operator reclaims control). */
  revokeAi(reason = 'user took control') {
    const active = this.activeExec;
    if (active === null) return false;
    const heldByAi = this.inputOwner === 'ai';
    // settle() already returns the token (logging "exec settled"); only record the reclaim when
    // the token was held somewhere else, so one event never produces two identical entries.
    this.#revokedSource = 'user revoke';
    active.settle({ waitReason: 'revoked', danger: undefined });
    if (!heldByAi) this.#log.append('input.owner', { actor: 'user', owner: 'user', reason });
    return true;
  }

  async close(reason = 'user closed') {
    if (this.#closed) return;
    this.#closed = true;
    const active = this.activeExec;
    this.#revokedSource = 'teardown';
    if (active !== null) active.settle({ waitReason: 'revoked' });
    this.#flushOutput();
    this.#log.append('session.close', { actor: 'user', reason });
    try {
      await this.#handle?.terminate();
    } catch (error) {
      this.#log.append('error', { actor: 'system', code: 'SSH_CLOSE_FAILED', text: String(error?.message ?? error) });
    }
    this.state = 'closed';
    this.#unsubscribeRing?.();
    this.#unsubscribeRing = null;
    this.#emit({ t: 'state', session: this.snapshot() });
    await this.#log.close();
  }
}
