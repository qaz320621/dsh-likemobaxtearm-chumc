// Windows/ConPTY adaptation: the defects reported from a real Windows 10 session, encoded as tests.
//
// Every pattern here comes from that report (`DSH-SSH控制台-Windows适配问题报告.md`): `\r\033[K`
// repaints, full-screen dumps landing inside the echoed command, sentinel dialects, and the paging
// that used to return mostly blank lines. The tests run anywhere — no ConPTY required — because the
// report's evidence was byte-level and the fixes are byte-level too.

import { readFileSync } from 'node:fs';

import { plainText, projectOutput } from '../src/ring.js';
import { SshSession } from '../src/session.js';
import { createMarker, markedInput, markerScript, parseMarker, stripEcho } from '../src/exec.js';

const ESC = '\u001b';
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: ok === true });
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`);
}

// The exact shapes the report captured: a cmd banner, a prompt, and the erase-to-end-of-line idiom.
const BANNER = 'Microsoft Windows [版本 10.0.19045.6093]';
const COPYRIGHT = '(c) Microsoft Corporation。保留所有权利。';
const PROMPT = 'chumc@DESKTOP-69I15KE C:\\Users\\chumc>';
const screenDump = `${BANNER}\r\n${COPYRIGHT}\r\n\r\n${PROMPT}`;

// ---------------------------------------------------------------- projection (report §1)

check('`\\r` rewrites the line instead of creating a blank one', plainText('loading 10%\rloading 99%\r') === 'loading 99%',
  JSON.stringify(plainText('loading 10%\rloading 99%\r')));
check('the erase-to-end-of-line idiom leaves no phantom line',
  plainText(`${PROMPT}echo hi\r${ESC}[K\r\nhi\r\n`) === `${PROMPT}echo hi\nhi\n`,
  JSON.stringify(plainText(`${PROMPT}echo hi\r${ESC}[K\r\nhi\r\n`)));
check('the same screen projects identically every time (so a fingerprint can catch it)',
  plainText(`${screenDump}\r${ESC}[K\r\n`) === plainText(`${screenDump}\r${ESC}[K\r\n`),
  JSON.stringify(plainText(`${screenDump}\r${ESC}[K\r\n`).split('\n').length) + ' lines');
check('consecutive blank lines collapse to the configured maximum', (() => {
  const noisy = `a\r\n\r\n\r\n\r\n\r\nb`;
  return plainText(noisy).split('\n').length === 3 && plainText(noisy, { maxConsecutiveBlankLines: 0 }) === 'a\nb';
})(), JSON.stringify(plainText('a\r\n\r\n\r\n\r\nb')));

const projected = projectOutput(`${PROMPT}dir\r${ESC}[K\r\n${BANNER}\r\n\r\n\r\nfile.txt\r\n`);
check('projection reports how much noise it folded', projected.rawBytes > projected.projectedBytes
  && projected.collapsedBytes === projected.rawBytes - projected.projectedBytes && projected.blankLines > 0,
  JSON.stringify({ raw: projected.rawBytes, kept: projected.projectedBytes, blanks: projected.blankLines, rewrites: projected.rewrites }));

// The report's headline ratio: `fullBytes / lines` was ~15 bytes/line on Windows.
const realisticFrame = `${PROMPT}echo hi\r${ESC}[K\r\nhi\r\n${BANNER}\r\n\r\n${COPYRIGHT}\r\n\r\n${PROMPT}`;
const frameProjection = projectOutput(realisticFrame);
const bytesPerLine = frameProjection.projectedBytes / frameProjection.lines;
check('bytes per projected line is back to real text density', bytesPerLine > 15 && bytesPerLine < 200,
  `${bytesPerLine.toFixed(1)} bytes/line (the reported Windows noise was 5–15)`);

// ---------------------------------------------------------------- the repaint decision

const decision = (over) => SshSession.repaintDecision({
  dedupe: true, state: 'ready', activeExec: false, sinceInputMs: 60000, idleMs: 2000,
  previousFingerprint: 'same', fingerprint: 'same', bytes: 400, lines: 8, ...over,
});
check('an idle identical full-screen frame is a repaint', decision({}) === true);
check('recent input disables deduplication (identical output can be real)', decision({ sinceInputMs: 200 }) === false);
check('a running AI command disables deduplication', decision({ activeExec: true }) === false);
check('a frame that differs is never dropped', decision({ fingerprint: 'other' }) === false);
check('small frames are never dropped', decision({ bytes: 40 }) === false);
check('single-line repeats are never dropped (tail -f style output)', decision({ lines: 1 }) === false);
check('the escape hatch turns it off entirely', decision({ dedupe: false }) === false);
check('a session that is not ready is not deduplicated', decision({ state: 'connecting' }) === false);
// 0.1.1 report: the approval banner resized the terminal (16↔14), ConPTY replayed the screen, and the
// replay — carrying OLD sentinel lines — landed inside the running exec's capture.
check('after a resize, a replayed screen is dropped even while a command runs',
  decision({ activeExec: true, recentResize: true, previousFingerprints: ['same'], previousFingerprint: 'other' }) === true);
check('after a resize, a screen we have never shown is kept',
  decision({ activeExec: true, recentResize: true, previousFingerprints: ['other'], fingerprint: 'new' }) === false);
check('without a resize the idle gates still apply', decision({ activeExec: true, recentResize: false, previousFingerprints: ['same'] }) === false);

// ---------------------------------------------------------------- the sentinel dialects (report §4)

const marker = createMarker();
check('the marker is token-safe', /^__DSH_SSH_DONE_[0-9a-f]{6}__$/.test(marker), marker);
check('POSIX uses printf with $?', markerScript(marker, 'posix').includes('printf') && markerScript(marker, 'posix').endsWith("$?"));
check('cmd uses `call echo` so %ERRORLEVEL% is re-expanded after the command ran',
  markerScript(marker, 'cmd').startsWith('call echo') && markerScript(marker, 'cmd').includes('%ERRORLEVEL%')
  && !/&\s*echo\s/.test(markerScript(marker, 'cmd')), markerScript(marker, 'cmd').slice(0, 48));
check('PowerShell uses Write-Output with $LASTEXITCODE',
  markerScript(marker, 'powershell').includes('Write-Output') && markerScript(marker, 'powershell').includes('$LASTEXITCODE'));
check('the marker stays concealed on every dialect (SGR 8)',
  ['posix', 'cmd', 'powershell'].every((shell) => markerScript(marker, shell).includes(`${ESC}[8m`) || markerScript(marker, shell).includes('\\033[8m')));
check('cmd puts the sentinel on its OWN line (a same-line %ERRORLEVEL% reports the previous command)',
  markedInput('dir', marker, 'cmd') === `dir\r${markerScript(marker, 'cmd')}\r`
  && !markedInput('dir', marker, 'cmd').includes('& call echo'),
  JSON.stringify(markedInput('dir', marker, 'cmd')));
check('the other dialects still join on one line',
  markedInput('ls', marker, 'posix').startsWith('ls; printf') && markedInput('ls', marker, 'powershell').startsWith('ls; Write-Output'));
check('a multi-line command also gets the sentinel on its own line on every dialect',
  ['posix', 'cmd', 'powershell'].every((shell) => markedInput('cat <<EOF\nx\nEOF', marker, shell).includes('\r')));

// The 0.1.1 report: a replayed old screen carried an EARLIER value of the current token, so parsing
// took it. The value must be the first one AFTER this token's own echo.
const stale = `old screen replay\r\n${ESC}[8m${marker}0${ESC}[0m\r\n`
  + `${PROMPT}cmd /c exit 5\r\n${markedInput('cmd /c exit 5', marker, 'cmd').replace(/\r$/, '')}\r\n`
  + `${ESC}[8m${marker}5${ESC}[0m\r\n${PROMPT}`;
check('a replayed older value of the same token is ignored (parse after this token\'s echo)',
  parseMarker(stale, marker)?.exitCode === 5, String(parseMarker(stale, marker)?.exitCode));
check('the stale value really is in that capture', stale.indexOf(`${marker}0`) < stale.indexOf(`${marker}5`));
check('without any echo the first value is still accepted (honest fallback)',
  parseMarker(`noise\r\n${ESC}[8m${marker}7${ESC}[0m\r\n`, marker)?.exitCode === 7);

for (const [shell, code] of [['posix', 3], ['cmd', 0], ['powershell', 7]]) {
  const line = markerScript(marker, shell).replace('%d', `${code}`).replace('%ERRORLEVEL%', `${code}`).replace('$LASTEXITCODE', `${code}`);
  check(`the ${shell} sentinel parses back to its exit code`, parseMarker(`noise\r\n${line}\r\n`, marker)?.exitCode === code,
    String(parseMarker(`noise\r\n${line}\r\n`, marker)?.exitCode));
}
check('the echoed sentinel (`%d`) never parses as an exit code',
  parseMarker(`printf '${ESC}[8m${marker}%d${ESC}[0m' $?\n`, marker) === null);

// ---------------------------------------------------------------- echo stripping (report §2)

// The report's §2 case, as ConPTY actually emits it: the repaint arrives as `\r`-redraws, so the
// projection keeps the final write of each line and the screen block that used to split the echo is
// removed before the echo matcher runs.
const interleaved = `${PROMPT}echo [DSH-AI] hello from the AI side - bidirectiona\r${ESC}[K`
  + `echo [DSH-AI] hello from the AI side - bidirectional visibility\r${ESC}[K\r\n`
  + `${screenDump}\r\n[DSH-AI] hello from the AI side\r\n${marker}0\r\n${PROMPT}`;
const interleavedOut = stripEcho(interleaved, {
  command: 'echo [DSH-AI] hello from the AI side - bidirectional visibility',
  marker,
  screens: [screenDump.replace(/\s+/g, ' ')],
});
check('a repaint inside the echoed command no longer defeats echo stripping',
  interleavedOut.startsWith('[DSH-AI] hello from the AI side')
  && !interleavedOut.includes('echo [D') && !interleavedOut.includes('echo [DSH-AI] hello from t'),
  JSON.stringify(interleavedOut));

// Realistic captures: the PTY echoes exactly what we wrote (literal `\033...` text), while the
// sentinel's own output carries real escape bytes that `plainText` strips.
const echoOf = (command, shell = 'posix') => markedInput(command, marker, shell).replace(/\r$/, '');

const posixRun = `${echoOf('echo hi')}\r\nhi\r\n${ESC}[8m${marker}2${ESC}[0m\r\nuser@host:$ `;
const posixOut = stripEcho(posixRun, { command: 'echo hi', marker });
check('a normal POSIX echo is removed and the output kept',
  posixOut.startsWith('hi') && !posixOut.includes('printf'), JSON.stringify(posixOut));

const noEol = `${echoOf('printf NOEOL')}\r\nNOEOL${ESC}[8m${marker}0${ESC}[0m\r\nuser@host:$ `;
check('output without a trailing newline survives sharing its line with the sentinel',
  stripEcho(noEol, { command: 'printf NOEOL', marker }).startsWith('NOEOL'),
  JSON.stringify(stripEcho(noEol, { command: 'printf NOEOL', marker })));

// A multi-line command writes the sentinel on its own line, so the heredoc body is echoed first.
// For a multi-line command the sentinel is written on its OWN line, so the fixture must echo the
// heredoc body and then the script line (`markedInput` writes `command\rscript\r`).
const heredoc = `cat <<EOF\r\nhello\r\nEOF\r\n${markerScript(marker, 'posix')}\r\nhello\r\n${ESC}[8m${marker}0${ESC}[0m\r\nuser@host:$ `;
const heredocOut = stripEcho(heredoc, { command: 'cat <<EOF\nhello\nEOF', marker });
check('a multi-line command does not delete output that repeats an input line',
  heredocOut.split('\n')[0] === 'hello' && !heredocOut.includes('printf'), JSON.stringify(heredocOut));

const cmdRun = `C:\\>${echoOf('echo hi', 'cmd')}\r\nhi\r\n${ESC}[8m${marker}0${ESC}[0m\r\nC:\\>`;
check('the cmd dialect strips cleanly too (the next prompt is trimmed as well)',
  stripEcho(cmdRun, { command: 'echo hi', marker, shell: 'cmd' }).trim() === 'hi',
  JSON.stringify(stripEcho(cmdRun, { command: 'echo hi', marker, shell: 'cmd' })));

// ------------------------------------------------- the 0.1.1 report's §8.5 acceptance cases
// `ver` must be exactly one line and `cmd /c exit 5` must be EMPTY: 0.1.2 left the prompt plus the
// echoed sentinel script behind whenever ConPTY wrapped the token.
const PROMPT_CMD = 'chumc@DESKTOP-69I15KE C:\\Users\\chumc>';
const wrappedMarker = `${marker.slice(0, 19)}\b\n${marker.slice(19)}`;
const verCapture = `${PROMPT_CMD}ver\r\n${ESC}[8m${wrappedMarker}%ERRORLEVEL%${ESC}[0m\r\n`
  + `${BANNER}\r\n${ESC}[8m${marker}0${ESC}[0m\r\n${PROMPT_CMD}`;
const verOut = stripEcho(verCapture, { command: 'ver', marker, shell: 'cmd' });
check('a wrapped token no longer leaves the echoed sentinel in the result (ver → exactly 1 line)',
  verOut === BANNER, JSON.stringify(verOut));
const exitCapture = `${PROMPT_CMD}cmd /c exit 5\r\n${ESC}[8m${marker}%ERRORLEVEL%${ESC}[0m\r\n`
  + `${ESC}[8m${marker}5${ESC}[0m\r\n${PROMPT_CMD}`;
check('a silent command yields an empty result (cmd /c exit 5 → "")',
  stripEcho(exitCapture, { command: 'cmd /c exit 5', marker, shell: 'cmd' }) === '',
  JSON.stringify(stripEcho(exitCapture, { command: 'cmd /c exit 5', marker, shell: 'cmd' })));

// ------------------------------------------------- the erase-to-end-of-line lesson (§8.3/§8.4)
check('plain mode prints the POSIX sentinel without erasing the line',
  markerScript(marker, 'posix', { markerMode: 'plain' }) === `printf '\\n${marker}%d\\n' $?`,
  markerScript(marker, 'posix', { markerMode: 'plain' }));
check('hidden mode is still available and still uses conceal + erase',
  markerScript(marker, 'posix', { markerMode: 'hidden' }).includes('\\033[8m')
  && markerScript(marker, 'posix', { markerMode: 'hidden' }).includes('\\033[K'),
  markerScript(marker, 'posix', { markerMode: 'hidden' }));
check('plain mode keeps the concealment-free cmd and PowerShell forms',
  !markerScript(marker, 'cmd', { markerMode: 'plain' }).includes(ESC)
  && !markerScript(marker, 'powershell', { markerMode: 'plain' }).includes(ESC));
const plainCapture = `user@h:$ echo hi; printf '\\n${marker}%d\\n' $?\r\nhi\r\n${marker}0\r\nuser@h:$ `;
check('a plain POSIX sentinel is stripped by the same boundary',
  stripEcho(plainCapture, { command: 'echo hi', marker, shell: 'posix', markerMode: 'plain' }) === 'hi',
  JSON.stringify(stripEcho(plainCapture, { command: 'echo hi', marker, shell: 'posix', markerMode: 'plain' })));
check('the Windows default marker mode is plain, not hidden', (() => {
  const source = readFileSync(new URL('../src/session.js', import.meta.url), 'utf8');
  return source.includes("process.platform === 'win32' ? 'plain' : 'hidden'");
})());
check('a session degrades after repeated marker timeouts instead of burning the full timeout', (() => {
  const source = readFileSync(new URL('../src/session.js', import.meta.url), 'utf8');
  return source.includes('markerUnavailable') && source.includes('markerFailThreshold') && source.includes('degradedTimeoutMs');
})());
check('revoked results name their source', (() => {
  const source = readFileSync(new URL('../src/session.js', import.meta.url), 'utf8');
  return source.includes("'user keystroke'") && source.includes("'user revoke'") && source.includes('revokedSource');
})());

// ------------------------------------------- 0.1.3 regression: the ORDER differs per dialect
// (0.1.4 report §9.2) On posix the command and the sentinel share one echoed line, so the output comes
// after the echo. On cmd the sentinel is written on its own line, so the real output sits BETWEEN the
// command echo and the sentinel echo — the fixture below is what the previous suite never covered,
// which is why truncating at the sentinel echo shipped a "body always empty" regression for cmd.
const cmdOrderCapture = (cmd, output) => `${PROMPT_CMD}${cmd}\r\n${output}${PROMPT_CMD}`
  + `${markedInput(cmd, marker, 'cmd').replace(/\r$/, '')}\r\n`
  + `${ESC}[8m${marker}%ERRORLEVEL%${ESC}[0m\r\n${ESC}[8m${marker}0${ESC}[0m\r\n${PROMPT_CMD}`;

for (const [cmd, output, expect] of [
  ['ver', `${BANNER}\r\n`, BANNER],
  ['echo CMD-TEXT-CHECK', 'CMD-TEXT-CHECK\r\n', 'CMD-TEXT-CHECK'],
  ['dir C:\\Users\\chumc', ' 驱动器 C 中的卷是 系统\r\n 目录\r\n', ' 驱动器 C 中的卷是 系统\n 目录'],
]) {
  const out = stripEcho(cmdOrderCapture(cmd, output), { command: cmd, marker, shell: 'cmd' });
  check(`cmd output survives the sentinel being on its own line (${cmd})`, out === expect, JSON.stringify(out));
}
check('cmd /c exit 5 stays empty in the cmd order too',
  stripEcho(cmdOrderCapture('cmd /c exit 5', ''), { command: 'cmd /c exit 5', marker, shell: 'cmd' }) === '');
check('a posix command with no output yields an empty body (the exit code comes from the marker)',
  stripEcho(`user@h:$ sh -c 'exit 9'; printf '\\n${marker}%d\\n' $?\r\n${marker}9\r\nuser@h:$ `,
    { command: "sh -c 'exit 9'", marker, shell: 'posix', markerMode: 'plain' }) === '');
check('the exit code still parses from a plain sentinel',
  parseMarker(`user@h:$ sh -c 'exit 9'; printf '\\n${marker.slice(0, 19)}\b\n${marker.slice(19)}%d\\n' $?\r\n${marker}9\r\n`,
    marker)?.exitCode === 9);
check('a wrapped sentinel script leaves no `\' $?` fragment behind',
  !stripEcho(`user@h:$ uname -sr; printf '\\n${marker}%d\\n' $?\r\nLinux 6.17.0-35-generic\r\n${marker}0\r\nuser@h:$ `,
    { command: 'uname -sr', marker, shell: 'posix', markerMode: 'plain' }).includes('$?'));

check('numeric output is never mistaken for sentinel plumbing (seq 1 3)',
  stripEcho(`user@h:$ seq 1 3; printf '\\n${marker}%d\\n' $?\r\n1\r\n2\r\n3\r\n${marker}0\r\nuser@h:$ `,
    { command: 'seq 1 3', marker, shell: 'posix', markerMode: 'plain' }) === '1\n2\n3');

// ---------------------------------------------------------------- shell detection (report §4)

check('detection recognises a cmd banner', SshSession.detectShell('unknown', `\r\n${BANNER}\r\n${COPYRIGHT}\r\n\r\nC:\\Users\\chumc>`) === 'cmd');
check('detection recognises a PowerShell prompt', SshSession.detectShell('unknown', 'PS C:\\Users\\chumc> ') === 'powershell');
check('detection recognises a POSIX prompt', SshSession.detectShell('unknown', 'root@master:~# ') === 'posix');
check('detection never overrides an explicit setting', SshSession.detectShell('cmd', 'root@master:~# ') === 'cmd');

// ---------------------------------------------------------------- diagnostics (report §5)

const source = readFileSync(new URL('../src/session.js', import.meta.url), 'utf8');
check('session.resize is logged with its source and de-duplication count',
  source.includes("this.#log.append('session.resize'") && source.includes('source,') && source.includes('duplicates:'));
check('the snapshot exposes the ConPTY counters',
  ['visibleBytes', 'repaintsSkipped', 'repaintBytesSaved', 'resizeDuplicates', 'detectedShell']
    .every((field) => source.includes(`${field}:`)));
check('an empty flush never writes a log entry (that was one entry per repaint)',
  /\n    if \(raw\.length === 0\) return;/.test(source));

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
