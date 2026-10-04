/**
 * The sentinel protocol that makes `ssh_exec` possible on a shared interactive PTY.
 *
 * Why a marker: the session is a real interactive shell, so there is no exit status on the wire.
 * We append a `printf` that prints `<token><exit code>`; the token appears in the echoed command
 * line as `<token>%d`, which never matches the `<token><digits>` output pattern, so the marker is
 * unambiguous. This is a heuristic (a command that leaves the shell busy, backgrounds itself, or
 * replaces the shell will not settle) and every caller labels it as such.
 */

import { plainText } from './ring.js';

const TOKEN_PREFIX = '__DSH_SSH_DONE_';

/** @returns {string} a token that cannot contain regex-special characters. */
export function createMarker() {
  const hex = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
  return `${TOKEN_PREFIX}${hex}__`;
}

export const SHELL_DIALECTS = ['posix', 'cmd', 'powershell'];

/**
 * The extra script written after the operator's command, per remote shell.
 *
 * The marker stays hidden on every dialect (SGR 8 conceal): even where the terminal ignores the
 * sequence, the raw stream still carries `<marker><digits>`, so parsing never depends on it.
 */
export function markerScript(marker, shell = 'posix', { markerMode = 'hidden' } = {}) {
  const plain = markerMode === 'plain';
  if (shell === 'cmd') {
    // Two measured facts from Windows 10: `%ERRORLEVEL%` on the SAME line as the command reports the
    // value from before it ran (`call` re-runs the already-substituted text, so it does not help);
    // and concealment is harmless while `\033[K` (erase) makes ConPTY drop the line entirely.
    return plain ? `call echo ${marker}%ERRORLEVEL%` : `call echo \u001b[8m${marker}%ERRORLEVEL%\u001b[0m`;
  }
  if (shell === 'powershell') {
    // $LASTEXITCODE is set by native executables; a pure cmdlet leaves it null (then no digits
    // follow the marker and the caller sees a timeout instead of a wrong code, which is honest).
    return plain
      ? `Write-Output "${marker}$LASTEXITCODE"`
      : `Write-Output "\u001b[8m${marker}$LASTEXITCODE\u001b[0m"`;
  }
  // POSIX: the concealed + erase-line form is invisible AND, on ConPTY, unobservable — a line printed
  // and erased inside one render frame produces no output bytes at all. `plain` keeps the marker.
  return plain
    ? `printf '\\n${marker}%d\\n' $?`
    : `printf '\\033[8m${marker}%d\\033[0m\\r\\033[K' $?`;
}

/**
 * The token, tolerant of ConPTY inserting `\b` + `\n` at a wrap point inside it
 * (`__DSH_SSH_DONE_f2\b\n85f4__`). Matching the literal never worked there, which is how a wrapped
 * token defeated both the echo boundary and the line filter.
 */
function splitTolerant(marker) {
  return String(marker)
    .split('')
    .map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\b\r\n]*');
}

/** The separator that joins the command and the sentinel for this shell. */
function separatorFor(shell) {
  return shell === 'cmd' ? ' & ' : '; ';
}

/** True when appending `; script` to the command would change its meaning. */
function needsOwnLine(command) {
  const trimmed = command.trimEnd();
  return trimmed.includes('\n') || /[&|\\]$/.test(trimmed);
}

/**
 * Text written to the shell: the command, then the marker script.
 *
 * `cmd` ALWAYS gets the sentinel on its own line. `call echo …%ERRORLEVEL%` appended to the same line
 * is not enough: cmd expands `%ERRORLEVEL%` while it parses that whole line, so the value is the one
 * from before the command ran, and `call` merely re-runs the already-substituted text. Measured on
 * Windows 10: `cmd /c exit 5 & call echo TOKEN%ERRORLEVEL%` reported 0. A separate line is parsed
 * after the command finished, which is the only reliable ordering cmd offers.
 */
export function markedInput(command, marker, shell = 'posix', { markerMode = 'hidden' } = {}) {
  const script = markerScript(marker, shell, { markerMode });
  if (needsOwnLine(command) || shell === 'cmd') return `${command}\r${script}\r`;
  return `${command}${separatorFor(shell)}${script}\r`;
}

/** Any place our sentinel can appear (used to keep it out of logs and reads). */
export const MARKER_PATTERN = /__DSH_SSH_DONE_[0-9a-f]{6}__/;

/** Remove every line carrying an internal sentinel. */
export function stripMarkers(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  if (!MARKER_PATTERN.test(text)) return text;
  return text
    .split('\n')
    .filter((line) => !MARKER_PATTERN.test(line))
    .join('\n');
}

/** Matches only the real output line, never the echoed `printf` (which shows a literal `%d`). */
export function markerRegExp(marker) {
  return new RegExp(`${splitTolerant(marker)}[\b\r\n]*(\\d+)`);
}

/** The echo of our own sentinel script: the token NOT followed by the exit code. */
export function markerEchoRegExp(marker) {
  return new RegExp(`${splitTolerant(marker)}(?![\b\r\n]*\\d)`);
}

/**
 * Find the settled marker in raw PTY output.
 * @returns {null | {exitCode: number, matchStart: number, matchEnd: number}}
 */
export function parseMarker(raw, marker) {
  const pattern = markerRegExp(marker);
  // ConPTY replays whole screens after a resize, so a capture can contain the CURRENT token twice:
  // once as the echoed script (value not yet expanded) and once as its real output. Anything before
  // that echo is replay noise, including old commands' sentinel lines, so the value must be the first
  // `<marker><digits>` that appears AFTER this token's own echo.
  const echo = markerEchoRegExp(marker).exec(raw);
  const searchFrom = echo === null ? 0 : echo.index + echo[0].length;
  const match = pattern.exec(raw.slice(searchFrom));
  if (match === null) return null;
  const start = searchFrom + match.index;
  return {
    exitCode: Number.parseInt(match[1], 10),
    matchStart: start,
    matchEnd: start + match[0].length,
  };
}

/**
 * Drop the echoed command even when the terminal wrapped it across lines.
 *
 * The PTY echoes what we write, and an 80-column terminal inserts line breaks mid-command, so a
 * per-line comparison leaves most of the echo behind. Walk the command and the output together,
 * ignoring wrapping line breaks, and remove exactly the region that matches the command. Any
 * mismatch means this is not an echo, and the text is returned untouched.
 */
function dropWrappedEcho(text, command) {
  const target = String(command ?? '').replace(/\s+/g, ' ').trim();
  if (target.length === 0 || text.length === 0) return text;
  let offset = 0;
  while (offset < text.length && (text[offset] === '\n' || text[offset] === '\r')) offset += 1;
  // The capture starts wherever the screen was, which is usually the shell's own prompt line. Skip
  // that prompt so the echo match begins at the command itself (a leading prompt used to make the
  // whole primary path fail, leaving the echoed sentinel in the model's result).
  const firstBreak = text.indexOf('\n', offset);
  const firstLine = firstBreak === -1 ? text.slice(offset) : text.slice(offset, firstBreak);
  const promptAt = Math.max(firstLine.lastIndexOf('>'), firstLine.lastIndexOf('$'), firstLine.lastIndexOf('#'));
  if (promptAt === firstLine.length - 1 && firstBreak !== -1) offset = firstBreak + 1;
  else if (promptAt >= 0) offset += promptAt + 1;
  while (offset < text.length && (text[offset] === ' ' || text[offset] === '\t')) offset += 1;
  const start = offset;
  let ti = 0;
  while (ti < target.length && offset < text.length) {
    const want = target[ti];
    const have = text[offset];
    if (want === ' ') {
      if (have === ' ' || have === '\n' || have === '\r' || have === '\t') { ti += 1; offset += 1; continue; }
      return text;
    }
    if (have === want) { ti += 1; offset += 1; continue; }
    if (have === '\n' || have === '\r') { offset += 1; continue; }
    return text;
  }
  if (ti < target.length) return text;
  while (offset < text.length && (text[offset] === '\r' || text[offset] === '\n' || text[offset] === ' ')) offset += 1;
  return text.slice(0, start) + text.slice(offset);
}

/**
 * Convert captured raw output into the text a human or the model should read.
 *
 * Order matters:
 *  1. remove screens the terminal already showed (a ConPTY repaint lands mid-echo, which is what
 *     used to split the echoed command beyond recognition);
 *  2. cut the echo using our OWN sentinel as the boundary — the shell echoes the sentinel script
 *     before it runs anything, so the first `<marker>` occurrence in the capture ends the echo;
 *  3. drop the marker lines and any residual echo line;
 *  4. trim surrounding blanks.
 */
export function stripEcho(raw, { command = '', marker = '', screens = [], shell = 'posix', markerMode = 'hidden' } = {}) {
  let text = plainText(raw);
  for (const screen of screens) {
    const block = String(screen ?? '').trim();
    if (block.length < 24) continue;
    if (text.includes(block)) { text = text.split(block).join(''); continue; }
    // Tolerate line-ending/whitespace drift between how the block was recorded and how it appears.
    const tokens = block.split(/\s+/).filter((token) => token.length > 0)
      .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (tokens.length < 3) continue;
    const pattern = new RegExp(tokens.join('\\s+'), 'g');
    if (pattern.test(text)) text = text.replace(pattern, '');
  }

  // Block-level deletion only — no "cut from a boundary" rule, because the order of the blocks differs
  // by dialect and a wrong assumption deletes real output:
  //   posix : prompt + command + sentinel script on ONE echoed line, then the output
  //   cmd   : command echo, then the OUTPUT, then the sentinel script echo (it is written on its own
  //           line), then the value — truncating at the sentinel echo threw the output away.
  // So: delete the four blocks and keep whatever is left between them.
  const singleLine = typeof command === 'string' && command.length > 0 && !command.includes('\n');
  const echoAt = marker.length > 0 ? markerEchoRegExp(marker).exec(text) : null;
  /** End offset of the line starting at `from`, including a wrapped continuation of a sentinel tail. */
  const lineEnd = (from, extendForTail = true) => {
    let end = text.indexOf('\n', from);
    end = end === -1 ? text.length : end + 1;
    if (!extendForTail) return end;
    const nextBreak = text.indexOf('\n', end);
    const tail = nextBreak === -1 ? text.slice(end) : text.slice(end, nextBreak);
    if (/%(?:ERRORLEVEL|d)|\$LASTEXITCODE|\\033|%s/.test(tail)) end = nextBreak === -1 ? text.length : nextBreak + 1;
    return end;
  };

  // Block A — the prompt plus the echoed command (with its wrapped continuation). In both dialects the
  // echo comes first, so deleting it from the start is safe; if the command never echoes (echo off),
  // nothing matches and nothing is removed.
  if (typeof command === 'string' && command.trim().length > 0) {
    const pattern = new RegExp(command.trim().split('').map((char) => {
      if (char === ' ' || char === '\t' || char === '\n') return '\\s+';
      return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('[\b\r\n]*'));
    const match = pattern.exec(text);
    if (match !== null && match.index <= 200) {
      const after = match.index + match[0].length;
      const skipTo = text.indexOf('\n', after);
      text = text.slice(skipTo === -1 ? text.length : skipTo + 1);
    }
  }

  // Block B — the echoed sentinel script, with its wrapped continuation.
  for (let pass = 0; pass < 4 && marker.length > 0; pass += 1) {
    const at = markerEchoRegExp(marker).exec(text);
    if (at === null) break;
    let begin = text.lastIndexOf('\n', at.index);
    begin = begin === -1 ? 0 : begin + 1;
    text = text.slice(0, begin) + text.slice(lineEnd(at.index + at[0].length));
  }

  // Fallback for a wrapped echo of a SINGLE-line command. A multi-line command's own lines must NOT
  // be listed here: in `cat <<EOF\nhello\nEOF` the line `hello` is both input and output, and the
  // fallback used to delete the real output with it.
  // Normalise both sides through `plainText`: the captured output is already projected, so comparing
  // it against the raw script (which still carries escape bytes) never matched and left the echoed
  // sentinel behind — that is how `printf '%d\r' $?` ended up in the model's output.
  const echoSources = [plainText(markerScript(marker, shell, { markerMode }))];
  if (typeof command === 'string' && command.length > 0 && !command.includes('\n')) echoSources.push(plainText(command));
  const echoed = new Set(
    echoSources.flatMap((value) => value.split('\n')).map((line) => line.trim()).filter((line) => line.length > 0),
  );
  // A wrapped token never appears literally, so also remove any line that only carries the sentinel.
  const markerLoose = new RegExp(`${splitTolerant(marker)}(?:\\d+|%d|%ERRORLEVEL%|\\$LASTEXITCODE)?`, 'g');
  const kept = [];
  for (const line of text.split('\n')) {
    let value = line;
    // A wrapped echo shares its final line with the sentinel script, so an exact whole-line match is
    // not enough: remove any known echo line that appears INSIDE this line first. Both sides still
    // carry the marker at this point, which is what makes the match exact.
    if (marker.length > 0) {
      markerLoose.lastIndex = 0;
      const withoutMarker = value.replace(markerLoose, '');
      if (withoutMarker !== value) {
        value = withoutMarker;
        if (value.replace(/[;&\s]+/g, '').length === 0) continue;
      }
    }
    for (const source of echoSources) {
      for (const part of source.split('\n')) {
        const piece = part.trim();
        if (piece.length >= 4 && value.includes(piece)) value = value.split(piece).join('');
      }
    }
    // Whatever remains of a stripped echo line is usually the separator or a wrapped fragment of the
    // sentinel script (`'; printf ...' $?` can break into a bare `' $?`). A line counts as plumbing
    // only when it actually contains a plumbing token — otherwise ordinary output such as `1` (from
    // `seq 1 400`) would be deleted, which it was.
    const plumbing = /printf|echo|call|Write-Output|%d|%ERRORLEVEL%|\$LASTEXITCODE|\$\?/.test(value);
    if (plumbing && value.replace(/printf|echo|call|Write-Output|%d|%ERRORLEVEL%|\$LASTEXITCODE|\$\?|[;&'"\s\\\d]+/g, '').length === 0) continue;
    if (echoed.has(value.trim())) continue;
    if (marker.length > 0 && value.includes(marker)) {
      // Strip the sentinel itself instead of dropping the whole line: an output that did not end in
      // a newline shares its line with the marker (`NOEOL<marker>0`), and that text is real output.
      value = value.replace(new RegExp(`${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d*`, 'g'), '');
      // Whatever is left of a marker line is either real output that shared the line (a command
      // without a trailing newline) or the sentinel script's own plumbing. Drop the plumbing.
      if (value.replace(/printf|echo|call|Write-Output|%d|%ERRORLEVEL%|\$LASTEXITCODE|\$\?|['"\s;\\\d]/g, '').length === 0) continue;
    }
    if (echoed.has(value.trim())) continue;
    kept.push(value);
  }
  while (kept.length > 0 && kept[0].trim() === '') kept.shift();
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  // The shell prints its next prompt right after the sentinel; it is not command output.
  if (kept.length > 0 && /(^|\s)[^\s]*[>$#]\s*$/.test(kept[kept.length - 1])) kept.pop();
  return kept.join('\n');
}

/**
 * Heuristic: does this output tail look like an interactive password prompt?
 * Used only to keep secrets out of the log; it is never a security boundary.
 */
export function looksLikeSecretPrompt(text) {
  const tail = plainText(text).split('\n').filter((line) => line.trim().length > 0).slice(-1)[0] ?? '';
  return /(password|passphrase|passcode|密码|口令|验证码|token)\s*[:：]?\s*$/i.test(tail.trim());
}
