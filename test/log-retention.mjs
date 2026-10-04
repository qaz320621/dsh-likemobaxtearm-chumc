// Log lifecycle: per-session files, gzip archiving by age, optional retention, and bounded reads.
// Everything runs in a temp directory — the operator's real logs are never touched.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { archiveLogs, listLogs, parseLogName, parseDurationMs, readLogFile } from '../src/log.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: ok === true });
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`);
}

const DAY = 86400000;
const HOUR = 3600000;
const root = mkdtempSync(join(tmpdir(), 'dsh-ssh-logs-'));
const logs = join(root, 'logs');
mkdirSync(logs, { recursive: true });

const ageFile = (path, days) => ageFileMs(path, days * DAY);
const ageFileMs = (path, ms) => {
  const when = (Date.now() - ms) / 1000;
  utimesSync(path, when, when);
};

const line = (ts, actor, kind, text) => `${JSON.stringify({ ts, actor, kind, text })}\n`;

// ---------------------------------------------------------------- file names

check('a log file name parses into session, host and stamp', (() => {
  const parsed = parseLogName('ssh-1-my-host_20261004-223000.jsonl');
  return parsed !== null && parsed.sessionId === 'ssh-1' && parsed.host === 'my-host'
    && parsed.stamp === '20261004-223000' && parsed.archived === false;
})(), JSON.stringify(parseLogName('ssh-1-my-host_20261004-223000.jsonl')));
check('an archived name keeps the same identity',
  parseLogName('ssh-12-10.0.0.9_20261004-223000.jsonl.gz')?.archived === true);
check('an unrelated file is not a log', parseLogName('notes.txt') === null && parseLogName('hosts.json') === null);

// ---------------------------------------------------------------- archiving

const oldPath = join(logs, 'ssh-1-master_20260101-000000.jsonl');
const freshPath = join(logs, 'ssh-2-master_20261004-223000.jsonl');
const livePath = join(logs, 'ssh-3-master_20260101-000000.jsonl');
const oldBody = line('2026-01-01T00:00:00Z', 'user', 'user.input', 'ls -a') + line('2026-01-01T00:00:01Z', 'remote', 'output', 'total 0');
writeFileSync(oldPath, oldBody);
writeFileSync(freshPath, line('2026-10-04T22:30:00Z', 'user', 'user.input', 'pwd'));
writeFileSync(livePath, line('2026-01-01T00:00:00Z', 'user', 'user.input', 'still-running'));
writeFileSync(join(logs, 'notes.txt'), 'not a log');
ageFile(oldPath, 30);
ageFile(livePath, 30); // old, but a live session is still writing to it

const swept = archiveLogs({ dir: logs, protect: [livePath], archiveAfterMs: 7 * DAY });
check('an aged log is gzipped into archive/', swept.archived.includes('ssh-1-master_20260101-000000.jsonl'),
  JSON.stringify(swept));
check('the original aged file is gone', !existsSync(oldPath));
check('the archive keeps the content byte for byte', (() => {
  const archived = join(logs, 'archive', 'ssh-1-master_20260101-000000.jsonl.gz');
  return existsSync(archived) && gunzipSync(readFileSync(archived)).toString('utf8') === oldBody;
})());
check('a recent log is left alone', existsSync(freshPath));
check('a live session\'s log is never moved, however old', existsSync(livePath) && !existsSync(join(logs, 'archive', 'ssh-3-master_20260101-000000.jsonl.gz')));
check('non-log files are ignored', existsSync(join(logs, 'notes.txt')));

// ---------------------------------------------------------------- retention

const archiveDir = join(logs, 'archive');
mkdirSync(archiveDir, { recursive: true });
const staleArchive = join(archiveDir, 'ssh-9-old_20250101-000000.jsonl.gz');
writeFileSync(staleArchive, gunzipSync(readFileSync(join(archiveDir, 'ssh-1-master_20260101-000000.jsonl.gz'))));
ageFile(staleArchive, 10);

const kept = archiveLogs({ dir: logs, archiveAfterMs: 7 * DAY, retentionMs: 0 });
check('retention 0 keeps archives forever', existsSync(staleArchive) && kept.deleted.length === 0, JSON.stringify(kept.deleted));
const pruned = archiveLogs({ dir: logs, archiveAfterMs: 7 * DAY, retentionMs: 3 * DAY });
check('retention N deletes only older archives', pruned.deleted.includes('ssh-9-old_20250101-000000.jsonl.gz')
  && existsSync(join(archiveDir, 'ssh-1-master_20260101-000000.jsonl.gz')), JSON.stringify(pruned.deleted));

// ---------------------------------------------------------------- durations (hour-scale archiving)

check('a bare number means days, and fractions are kept', parseDurationMs(0.5, 'd') === 12 * HOUR
  && parseDurationMs(7, 'd') === 7 * DAY && parseDurationMs('0.25', 'd') === 6 * HOUR, String(parseDurationMs(0.5, 'd')));
check('an explicit unit overrides the default', parseDurationMs('12h', 'd') === 12 * HOUR
  && parseDurationMs('90m', 'd') === 90 * 60000 && parseDurationMs('30s', 'd') === 30000
  && parseDurationMs('2d', 'd') === 2 * DAY && parseDurationMs('500ms', 'd') === 500);
check('rubbish is refused instead of becoming zero', parseDurationMs('soon', 'd') === null
  && parseDurationMs(-1, 'd') === null && parseDurationMs('', 'd') === null && parseDurationMs(Number.NaN, 'd') === null
  && parseDurationMs('12x', 'd') === null);

// Hour-scale: a two-hour-old log ages out with a one-hour threshold, a half-hour-old one does not.
const hourDir = join(root, 'hourly');
mkdirSync(hourDir, { recursive: true });
const twoHours = join(hourDir, 'ssh-21-master_20261004-200000.jsonl');
const halfHour = join(hourDir, 'ssh-22-master_20261004-220000.jsonl');
writeFileSync(twoHours, line('2026-10-04T20:00:00Z', 'user', 'user.input', 'old'));
writeFileSync(halfHour, line('2026-10-04T22:00:00Z', 'user', 'user.input', 'new'));
ageFileMs(twoHours, 2 * HOUR);
ageFileMs(halfHour, 30 * 60000);
const hourly = archiveLogs({ dir: hourDir, archiveAfterMs: parseDurationMs('1h') });
check('an hour-scale threshold archives only what is older than it',
  hourly.archived.includes('ssh-21-master_20261004-200000.jsonl')
  && !hourly.archived.includes('ssh-22-master_20261004-220000.jsonl'), JSON.stringify(hourly.archived));
check('a sub-day archive is still readable', readLogFile({ dir: hourDir, name: 'ssh-21-master_20261004-200000.jsonl.gz' }).entries[0]?.text === 'old');

const offDir = join(root, 'off');
mkdirSync(offDir, { recursive: true });
const offFile = join(offDir, 'ssh-23-master_20260101-000000.jsonl');
writeFileSync(offFile, line('2026-01-01T00:00:00Z', 'user', 'user.input', 'ancient'));
ageFileMs(offFile, 30 * DAY);
const disabled = archiveLogs({ dir: offDir, archiveAfterMs: 0 });
check('0 disables archiving instead of archiving everything', disabled.archived.length === 0 && existsSync(offFile),
  JSON.stringify(disabled.archived));

// ---------------------------------------------------------------- listing

const listing = listLogs({ dir: logs, limit: 100 });
const names = listing.files.map((file) => file.name);
check('listings include current and archived files', names.includes('ssh-2-master_20261004-223000.jsonl')
  && names.includes('ssh-1-master_20260101-000000.jsonl.gz'), JSON.stringify(names));
check('listing kinds are marked', listing.files.find((file) => file.name.endsWith('.gz'))?.kind === 'archived'
  && listing.files.find((file) => !file.name.endsWith('.gz'))?.kind === 'current');
check('the listing carries session identity and size',
  listing.files.every((file) => typeof file.size === 'number' && file.sessionId.startsWith('ssh-'))
  && listing.dir === logs, JSON.stringify(listing.files[0]));
check('listings are newest first', listing.files.every((file, index) => index === 0 || listing.files[index - 1].mtime >= file.mtime));
check('a listing limit is honoured', listLogs({ dir: logs, limit: 1 }).files.length === 1 && listLogs({ dir: logs, limit: 1 }).total > 1);

// ---------------------------------------------------------------- reading

const current = readLogFile({ dir: logs, name: 'ssh-2-master_20261004-223000.jsonl' });
check('a current log reads back as entries', current.kind === 'current' && current.entries.length === 1
  && current.entries[0].text === 'pwd', JSON.stringify(current.entries));
const archived = readLogFile({ dir: logs, name: 'ssh-1-master_20260101-000000.jsonl.gz' });
check('an archived log reads back as entries', archived.kind === 'archived' && archived.entries.length === 2
  && archived.entries[0].command === undefined && archived.entries[0].text === 'ls -a', JSON.stringify(archived.entries));
check('a read reports how much of the file it returned',
  archived.totalLines === 2 && archived.lines === 2 && archived.truncated === false);

const many = join(logs, 'ssh-4-master_20261004-230000.jsonl');
writeFileSync(many, Array.from({ length: 50 }, (_, index) => line(`2026-10-04T23:00:${String(index % 60).padStart(2, '0')}Z`, 'remote', 'output', `line ${index}`)).join(''));
const tail = readLogFile({ dir: logs, name: 'ssh-4-master_20261004-230000.jsonl', maxLines: 10 });
check('only the requested tail is returned', tail.lines === 10 && tail.totalLines === 50 && tail.truncated === true
  && tail.entries.at(-1).text === 'line 49', JSON.stringify({ lines: tail.lines, total: tail.totalLines }));

// ---------------------------------------------------------------- refusals

check('a traversal name is refused', readLogFile({ dir: logs, name: '../logs/ssh-2-master_20261004-223000.jsonl' }).error === 'SSH_LOG_NAME');
check('an unknown file is reported, not guessed', readLogFile({ dir: logs, name: 'ssh-77-host_20260101-000000.jsonl' }).error === 'SSH_LOG_MISSING');
check('a non-log name is refused', readLogFile({ dir: logs, name: 'hosts.json' }).error === 'SSH_LOG_NAME');

const huge = join(logs, 'ssh-5-master_20261004-231000.jsonl');
writeFileSync(huge, `${'x'.repeat(64 * 1024)}\n${line('2026-10-04T23:10:00Z', 'remote', 'output', 'tail-marker')}`);
const capped = readLogFile({ dir: logs, name: 'ssh-5-master_20261004-231000.jsonl', maxBytes: 4096 });
check('a file over the read cap is read from the end', capped.truncated === true && capped.entries.at(-1).text === 'tail-marker'
  && capped.entries.every((entry) => entry.kind !== 'raw'), JSON.stringify({ lines: capped.lines, total: capped.totalLines }));

const hugeArchive = join(archiveDir, 'ssh-6-master_20260101-000000.jsonl.gz');
writeFileSync(hugeArchive, gzipSync(Buffer.from('y'.repeat(2 * 1024 * 1024))));
const refused = readLogFile({ dir: logs, name: 'ssh-6-master_20260101-000000.jsonl.gz', maxBytes: 64 * 1024 });
check('an archive needing more than the cap is refused with its size',
  refused.error === 'SSH_LOG_TOO_LARGE' && refused.uncompressedBytes >= 2 * 1024 * 1024, JSON.stringify(refused));

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
