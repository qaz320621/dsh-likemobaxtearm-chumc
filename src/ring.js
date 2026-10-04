/**
 * Bounded retained output for one SSH session: append raw PTY chunks, page them by line,
 * and hand stream clients everything after a monotonic sequence number.
 */

const ANSI_CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const ANSI_OTHER = /\u001b[@-Z\\-_]/g;

/**
 * Fold a terminal's own repaint idioms into readable text.
 *
 * `\r` means "carriage return": everything after the last `\r` on a line is what that line finally
 * shows, and the bytes before it were overwritten. Treating `\r` as a line break — which is what this
 * did before — turned every `\r\033[K` repaint into a phantom blank line. On Windows (ConPTY) that
 * made ~85% of the captured bytes and >90% of the reported "lines" pure noise: the audit log filled
 * with 5–15 byte/line fragments and `ssh_read` paging returned mostly empty lines.
 *
 * Consecutive blank lines are collapsed to `maxConsecutiveBlankLines` (1 keeps a single separator,
 * 0 drops them all). Nothing is lost silently: callers record `rawBytes` alongside the projection.
 */
export function plainText(raw, { maxConsecutiveBlankLines = 1 } = {}) {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  const stripped = raw
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_OTHER, '')
    .replace(/\r\n/g, '\n');
  const lines = stripped.split('\n').map(collapseCarriageReturn);
  const kept = [];
  let blanks = 0;
  const max = Math.max(0, Number(maxConsecutiveBlankLines) || 0);
  for (const line of lines) {
    if (line.trim().length === 0) {
      blanks += 1;
      if (blanks > max) continue;
      kept.push('');
      continue;
    }
    blanks = 0;
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * The last non-empty write to a line wins: `foo\rbar` shows `bar`.
 *
 * A *trailing* `\r` (the shell returning the cursor to column 0 without writing) must not erase the
 * line — that mistake would blank every repainted prompt, which is the opposite of the bug being fixed.
 */
function collapseCarriageReturn(line) {
  if (!line.includes('\r')) return line;
  const parts = line.split('\r');
  let current = parts[0];
  for (let index = 1; index < parts.length; index += 1) {
    if (parts[index].length > 0) current = parts[index];
  }
  return current;
}

/**
 * Projection with the accounting a log entry needs: what the text costs, and how much of the raw
 * stream the projection folded away.
 */
export function projectOutput(raw, { maxConsecutiveBlankLines = 1 } = {}) {
  const source = typeof raw === 'string' ? raw : String(raw ?? '');
  const text = plainText(source, { maxConsecutiveBlankLines });
  const rawBytes = Buffer.byteLength(source, 'utf8');
  const projectedBytes = Buffer.byteLength(text, 'utf8');
  const rawLines = source.length === 0 ? 0 : source.split('\n').length;
  const lines = text.length === 0 ? 0 : text.split('\n').length;
  return {
    text,
    rawBytes,
    projectedBytes,
    collapsedBytes: Math.max(0, rawBytes - projectedBytes),
    rawLines,
    lines,
    blankLines: Math.max(0, rawLines - lines),
    rewrites: (source.match(/\r(?!\n)/g) ?? []).length,
  };
}

function countNewlines(text) {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}

export class OutputRing {
  #chunks = [];
  #bytes = 0;
  #newlines = 0;
  #seq = 0;
  #maxBytes;
  #maxChunks;
  #listeners = new Set();

  constructor({ maxBytes = 4 * 1024 * 1024, maxChunks = 4000 } = {}) {
    this.#maxBytes = maxBytes;
    this.#maxChunks = maxChunks;
  }

  get seq() { return this.#seq; }

  /** Subscribe to every appended chunk; returns an unsubscribe function. */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /** @returns {{seq: number, data: string, bytes: number}} */
  append(data) {
    if (typeof data !== 'string' || data.length === 0) return { seq: this.#seq, data: '', bytes: 0 };
    const bytes = Buffer.byteLength(data, 'utf8');
    const record = { seq: ++this.#seq, data, bytes };
    this.#chunks.push(record);
    this.#bytes += bytes;
    this.#newlines += countNewlines(data);
    this.#trim();
    for (const listener of this.#listeners) {
      try { listener(record); } catch { /* a broken subscriber must not break the session */ }
    }
    return record;
  }

  #trim() {
    while (this.#chunks.length > this.#maxChunks || (this.#bytes > this.#maxBytes && this.#chunks.length > 1)) {
      const dropped = this.#chunks.shift();
      this.#bytes -= dropped.bytes;
      this.#newlines -= countNewlines(dropped.data);
    }
  }

  /** Raw text of every retained chunk with `seq > fromSeq`. */
  since(fromSeq = 0) {
    let out = '';
    for (const chunk of this.#chunks) if (chunk.seq > fromSeq) out += chunk.data;
    return out;
  }

  /** All retained raw text. */
  all() {
    let out = '';
    for (const chunk of this.#chunks) out += chunk.data;
    return out;
  }

  get retainedBytes() { return this.#bytes; }

  /** Total lines ever appended, counting a trailing partial line. */
  get totalLines() {
    const text = this.all();
    if (text.length === 0) return 0;
    return countNewlines(text) + (text.endsWith('\n') ? 0 : 1);
  }

  /**
   * Newest-relative line page over the PROJECTED text: `offset` 0 is the last visible line.
   * Paging raw bytes is useless on a ConPTY session, where most "lines" are repaint residue.
   */
  readLines({ offset = 0, count = 500, maxConsecutiveBlankLines = 1 } = {}) {
    const text = plainText(this.all(), { maxConsecutiveBlankLines });
    const lines = text.length === 0 ? [] : text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const total = lines.length;
    const end = Math.max(0, total - Math.max(0, offset));
    const begin = Math.max(0, end - Math.max(1, count));
    return {
      text: lines.slice(begin, end).join('\n'),
      totalLines: total,
      lineBegin: begin,
      lineEnd: end,
      truncated: begin > 0,
    };
  }

  /** Last `maxChars` characters, trimmed forward to a line boundary. */
  tailText(maxChars) {
    const text = this.all();
    if (text.length <= maxChars) return text;
    const cut = text.slice(text.length - maxChars);
    const nl = cut.indexOf('\n');
    return nl >= 0 ? cut.slice(nl + 1) : cut;
  }

  /** Last `lines` lines of plain (control-sequence-free) text. */
  tailPlainLines(lines, { maxConsecutiveBlankLines = 1 } = {}) {
    const text = plainText(this.all(), { maxConsecutiveBlankLines });
    if (text.length === 0) return '';
    const split = text.split('\n');
    if (split.length > 0 && split[split.length - 1] === '') split.pop();
    return split.slice(Math.max(0, split.length - lines)).join('\n');
  }
}
