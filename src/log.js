/**
 * Durable JSONL activity log for one SSH session.
 *
 * Storage rules (agreed with the operator):
 *  - commands are stored in full, never truncated;
 *  - captured output is truncated to `outputTruncateChars` (default 200) and the entry records
 *    `truncated`, `fullBytes` and `lines` so nothing is silently lost;
 *  - secrets that follow an interactive password prompt are stored as `[redacted]`.
 */

import {
  closeSync, createWriteStream, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { plainText } from './ring.js';

/** Kinds whose `text` field obeys the output truncation rule. */
const OUTPUT_KINDS = new Set(['output', 'ai.result']);
const OUTPUT_TRUNCATE_KINDS = OUTPUT_KINDS;

function safeName(value) {
  return String(value ?? 'unknown').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64);
}

function stamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export class SessionLog {
  #stream = null;
  #bytes = 0;
  #memory = [];
  #memoryLimit;
  #outputTruncateChars;
  #maxBytes;
  #enabled;
  #closed = false;

  /**
   * @param {object} options
   * @param {string} options.dir absolute log directory
   * @param {string} options.sessionId plugin session id
   * @param {string} options.hostLabel human-readable host label
   * @param {boolean} [options.enabled]
   * @param {number} [options.outputTruncateChars]
   * @param {number} [options.maxBytes]
   * @param {number} [options.memoryLimit]
   */
  constructor({ dir, sessionId, hostLabel, enabled = true, outputTruncateChars = 200, maxBytes = 8 * 1024 * 1024, memoryLimit = 4000 }) {
    this.dir = dir;
    this.sessionId = sessionId;
    this.hostLabel = hostLabel;
    this.#enabled = enabled;
    this.#outputTruncateChars = Math.max(0, outputTruncateChars);
    this.#maxBytes = maxBytes;
    this.#memoryLimit = memoryLimit;
    this.path = join(dir, `${safeName(sessionId)}-${safeName(hostLabel)}_${stamp(new Date())}.jsonl`);
    if (this.#enabled) {
      try {
        mkdirSync(dir, { recursive: true });
        this.#stream = createWriteStream(this.path, { flags: 'a' });
        this.#stream.on('error', () => { this.#stream = null; });
      } catch {
        this.#stream = null;
      }
    }
  }

  get filePath() { return this.#enabled ? this.path : null; }

  get writable() { return this.#stream !== null && !this.#closed; }

  /**
   * Record one activity entry.
   * @param {string} kind one of the documented log kinds
   * @param {object} [fields] actor, text, command, exitCode, danger, sensitive, code, ...
   */
  append(kind, fields = {}) {
    const entry = {
      ts: new Date().toISOString(),
      seq: this.#memory.length + 1,
      sessionId: this.sessionId,
      host: this.hostLabel,
      actor: fields.actor ?? 'system',
      kind,
    };
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'actor' || value === undefined) continue;
      entry[key] = value;
    }
    if (typeof entry.text === 'string' && OUTPUT_TRUNCATE_KINDS.has(kind)) {
      entry.text = plainText(entry.text);
      Object.assign(entry, this.truncateOutput(entry.text));
    }
    this.#memory.push(entry);
    if (this.#memory.length > this.#memoryLimit) this.#memory.splice(0, this.#memory.length - this.#memoryLimit);
    this.#write(entry);
    return entry;
  }

  /** Apply the agreed output truncation rule. */
  truncateOutput(text) {
    const value = typeof text === 'string' ? text : '';
    const bytes = Buffer.byteLength(value, 'utf8');
    const lines = value.length === 0 ? 0 : value.split('\n').length;
    if (this.#outputTruncateChars === 0 || value.length <= this.#outputTruncateChars) {
      return { text: value, truncated: false, fullBytes: bytes, lines };
    }
    return {
      text: value.slice(0, this.#outputTruncateChars),
      truncated: true,
      fullBytes: bytes,
      lines,
    };
  }

  #write(entry) {
    if (!this.writable) return;
    let line;
    try {
      line = `${JSON.stringify(entry)}\n`;
    } catch {
      return;
    }
    const size = Buffer.byteLength(line, 'utf8');
    if (this.#bytes + size > this.#maxBytes) {
      const notice = `${JSON.stringify({ ts: new Date().toISOString(), sessionId: this.sessionId, host: this.hostLabel, actor: 'system', kind: 'log.rotated', reason: 'maxBytes', bytes: this.#bytes })}\n`;
      try { this.#stream.write(notice); } catch { /* ignore */ }
      this.#stream.end();
      this.#stream = null;
      return;
    }
    this.#bytes += size;
    try { this.#stream.write(line); } catch { /* ignore */ }
  }

  /** In-memory tail, newest last, optionally filtered. */
  entries({ actor, kind, limit = 200 } = {}) {
    const filtered = this.#memory.filter((entry) =>
      (actor === undefined || entry.actor === actor) && (kind === undefined || entry.kind === kind));
    return filtered.slice(Math.max(0, filtered.length - Math.max(1, limit)));
  }

  /** @returns {Promise<void>} resolves once queued writes reached the file */
  close() {
    return new Promise((resolve) => {
      this.#closed = true;
      const stream = this.#stream;
      this.#stream = null;
      if (stream === null) { resolve(); return; }
      stream.end(() => resolve());
    });
  }
}

// ---------------------------------------------------------------- log lifecycle
//
// One file per SSH session, named `<sessionId>-<host>_<YYYYMMDD-HHMMSS>.jsonl`. Files are never
// deleted implicitly: aging files are gzipped into `archive/` (history stays readable but ~10x
// smaller), and only an explicitly configured retention window removes archives.

const LOG_FILE = /^(ssh-\d+)-(.*)_(\d{8}-\d{6})\.jsonl(\.gz)?$/;
const ARCHIVE_DIR = 'archive';

const SECOND = 1000;
const DURATION_UNITS = { ms: 1, s: SECOND, m: 60 * SECOND, h: 3600 * SECOND, d: 24 * 3600 * SECOND };
const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i;

/**
 * Parse a duration into milliseconds.
 *
 * A bare number means "that many `defaultUnit`" (days for the log keys) and **fractions are kept**,
 * so `0.5` is twelve hours rather than zero; an explicit unit is honoured (`12h`, `90m`, `7d`, `30s`).
 * Returns `null` for anything unparseable, so a caller can fall back instead of silently archiving
 * everything — which is exactly what integer truncation of `0.5` used to do.
 */
export function parseDurationMs(value, defaultUnit = 'd') {
  const fallbackScale = DURATION_UNITS[defaultUnit] ?? DURATION_UNITS.d;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value * fallbackScale : null;
  }
  if (typeof value !== 'string') return null;
  const match = DURATION.exec(value.trim());
  if (match === null) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = (match[2] ?? defaultUnit).toLowerCase();
  const scale = DURATION_UNITS[unit];
  return scale === undefined ? null : amount * scale;
}

/** Parse a log file name; unknown names are listed but carry no session identity. */
export function parseLogName(name) {
  const match = LOG_FILE.exec(String(name));
  if (match === null) {
    return String(name).endsWith('.jsonl') || String(name).endsWith('.jsonl.gz')
      ? { sessionId: '', host: '', stamp: '', archived: String(name).endsWith('.gz') }
      : null;
  }
  const [, sessionId, host, stamp, gz] = match;
  return { sessionId, host, stamp, archived: gz === '.gz' };
}

/** The uncompressed size recorded in a gzip member's trailer, without decompressing. */
function gzipUncompressedSize(path, compressedSize) {
  if (compressedSize < 4) return 0;
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(4);
    readSync(fd, buffer, 0, 4, compressedSize - 4);
    return buffer.readUInt32LE(0);
  } finally {
    closeSync(fd);
  }
}

function megabytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Age out finished logs: gzip anything older than `archiveAfterDays` into `archive/`, then (only
 * when `retentionDays > 0`) delete archives older than that. Live sessions are protected — their
 * files are still being appended to.
 */
export function archiveLogs({ dir, protect = [], archiveAfterMs = 7 * 24 * 3600 * 1000, retentionMs = 0, now = Date.now() }) {
  const result = { archived: [], deleted: [], errors: [] };
  const archiveDir = join(dir, ARCHIVE_DIR);
  let names = [];
  try { names = readdirSync(dir); } catch { return result; } // no log directory yet
  // 0 disables archiving (it does NOT mean "archive everything now"): a caller that wants aggressive
  // archiving writes a real duration such as `30s`.
  const threshold = Number(archiveAfterMs);
  if (!Number.isFinite(threshold) || threshold <= 0) return result;
  const cutoff = now - threshold;
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(dir, name);
    if (protect.includes(path)) continue;
    let stat;
    try { stat = statSync(path); } catch { continue; }
    if (!stat.isFile() || stat.mtimeMs > cutoff) continue;
    try {
      mkdirSync(archiveDir, { recursive: true });
      writeFileSync(join(archiveDir, `${name}.gz`), gzipSync(readFileSync(path), { level: 6 }));
      unlinkSync(path);
      result.archived.push(name);
    } catch (error) {
      result.errors.push(`${name}: ${error?.message ?? error}`);
    }
  }
  const keep = Number(retentionMs);
  if (Number.isFinite(keep) && keep > 0) {
    const retentionCutoff = now - keep;
    let archived = [];
    try { archived = readdirSync(archiveDir); } catch { archived = []; }
    for (const name of archived) {
      if (!name.endsWith('.jsonl.gz')) continue;
      const path = join(archiveDir, name);
      try {
        if (statSync(path).mtimeMs < retentionCutoff) {
          unlinkSync(path);
          result.deleted.push(name);
        }
      } catch (error) {
        result.errors.push(`${name}: ${error?.message ?? error}`);
      }
    }
  }
  return result;
}

/** Every log file (current and archived), newest first, with parsed identity and size. */
export function listLogs({ dir, limit = 200, archiveAfterMs = 0, retentionMs = 0 }) {
  const files = [];
  const collect = (base, archived) => {
    let names = [];
    try { names = readdirSync(base); } catch { return; }
    for (const name of names) {
      const parsed = parseLogName(name);
      if (parsed === null) continue;
      let stat;
      try { stat = statSync(join(base, name)); } catch { continue; }
      if (!stat.isFile()) continue;
      files.push({ name, kind: archived ? 'archived' : 'current', size: stat.size, mtime: stat.mtimeMs, ...parsed });
    }
  };
  collect(dir, false);
  collect(join(dir, ARCHIVE_DIR), true);
  files.sort((left, right) => right.mtime - left.mtime);
  return {
    dir,
    archiveDir: join(dir, ARCHIVE_DIR),
    archiveAfterMs: Number(archiveAfterMs) || 0,
    retentionMs: Number(retentionMs) || 0,
    total: files.length,
    files: files.slice(0, Math.max(1, Number(limit) || 200)),
  };
}

/**
 * Read one log file's tail. Path traversal is rejected by name validation, a plain file larger than
 * `maxBytes` is read from the end, and a gzip member larger than that is refused with its size
 * rather than decompressed.
 */
export function readLogFile({ dir, name, maxLines = 300, maxBytes = 8 * 1024 * 1024 }) {
  const requested = String(name ?? '');
  const safe = basename(requested);
  if (safe !== requested || safe.length === 0 || parseLogName(safe) === null) {
    return { error: 'SSH_LOG_NAME', message: '非法的日志文件名。' };
  }
  const archived = safe.endsWith('.gz');
  const path = join(dir, archived ? ARCHIVE_DIR : '', safe);
  let stat;
  try { stat = statSync(path); } catch { return { error: 'SSH_LOG_MISSING', message: '日志文件不存在（可能已被归档或清理）。' }; }
  const cap = Math.max(1024, Number(maxBytes) || 8 * 1024 * 1024);
  let text = '';
  let fromTail = false;
  let uncompressedBytes = stat.size;
  if (archived) {
    uncompressedBytes = gzipUncompressedSize(path, stat.size);
    if (uncompressedBytes > cap) {
      return {
        error: 'SSH_LOG_TOO_LARGE',
        message: `归档解压后约 ${megabytes(uncompressedBytes)}，超过单次读取上限 ${megabytes(cap)}；请在磁盘上查看。`,
        uncompressedBytes,
      };
    }
    text = gunzipSync(readFileSync(path)).toString('utf8');
  } else if (stat.size > cap) {
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(cap);
      readSync(fd, buffer, 0, cap, stat.size - cap);
      text = buffer.toString('utf8');
      fromTail = true;
    } finally {
      closeSync(fd);
    }
  } else {
    text = readFileSync(path, 'utf8');
  }
  if (fromTail) {
    // The read started mid-line: drop that partial first line.
    const firstBreak = text.indexOf('\n');
    text = firstBreak === -1 ? '' : text.slice(firstBreak + 1);
  }
  const all = text.split('\n').filter((line) => line.trim().length > 0);
  const lines = all.slice(-Math.max(1, Number(maxLines) || 300));
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch { entries.push({ kind: 'raw', text: line }); }
  }
  return {
    name: safe,
    kind: archived ? 'archived' : 'current',
    size: stat.size,
    mtime: stat.mtimeMs,
    uncompressedBytes,
    totalLines: all.length,
    lines: lines.length,
    // Either the line window or the byte cap cut the file down.
    truncated: fromTail || lines.length < all.length,
    entries,
  };
}
