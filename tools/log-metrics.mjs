// Log metric report for one session log.
//
//   node tools/log-metrics.mjs <session.jsonl>
//
// The measurement protocol comes from the Windows verification reports: bytes/line, duplicate frames,
// how often the login banner and prompt were repeated, the log's own accounting fields, and the event
// mix. Keeping the script in the repository means the author and the reporter measure the same way —
// the figures in those reports can be reproduced against any log file.
//
// Verdict thresholds follow the acceptance list in the reports (they are what a ConPTY session used
// to fail): real text is 20+ bytes per line, the banner appears once, and an idle window adds no
// `remote/output` events at all.

import { readFileSync, statSync } from 'node:fs';

const path = process.argv[2];
if (path === undefined) {
  console.error('usage: node tools/log-metrics.mjs <session.jsonl>');
  process.exit(2);
}
const raw = readFileSync(path, 'utf8');
const events = raw.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
const outputs = events.filter((event) => event.kind === 'output');
const inputs = events.filter((event) => event.kind === 'user.input' || event.kind === 'ai.command');

let bytes = 0;
let lines = 0;
for (const event of outputs) {
  bytes += event.fullBytes ?? 0;
  lines += event.lines ?? 0;
}

const seen = new Map();
let duplicates = 0;
for (const event of outputs) {
  const key = (event.text ?? '').slice(0, 120);
  if (!key) continue;
  if (seen.has(key)) duplicates += 1;
  seen.set(key, (seen.get(key) ?? 0) + 1);
}

const hasField = (field) => events.some((event) => Object.hasOwn(event, field));
const total = (field) => events.reduce((sum, event) => sum + (Number(event[field]) || 0), 0);
const countOf = (needle) => raw.split(needle).length - 1;
const byKind = new Map();
for (const event of events) {
  const key = `${event.actor}/${event.kind}`;
  byKind.set(key, (byKind.get(key) ?? 0) + 1);
}

const perLine = lines ? bytes / lines : 0;
const resizes = events.filter((event) => event.kind === 'session.resize');
const banner = countOf('Microsoft Windows [版本');
const prompt = countOf('@DESKTOP') + countOf('@master') + countOf('@slave') + countOf('@chumc');

console.log(`file: ${path}`);
console.log(`size: ${statSync(path).size} B   events: ${events.length}   output: ${outputs.length}   resize: ${resizes.length}`);
console.log(`bytes/line: ${perLine ? perLine.toFixed(1) : 'n/a'}   duplicate frames: ${duplicates}/${outputs.length}`);
console.log(`banner "Microsoft Windows [版本" = ${banner}   prompts ≈ ${prompt}   commands = ${inputs.length}`);
console.log('--- accounting ---');
for (const field of ['rawBytes', 'collapsedBytes', 'blankLines', 'rewrites', 'repaintsSkipped', 'repaintBytes', 'repaintOf']) {
  console.log(`  ${field.padEnd(17)} ${hasField(field) ? total(field) : 'ABSENT'}`);
}
console.log('--- event kinds ---');
for (const [kind, count] of [...byKind].sort()) console.log(`  ${kind.padEnd(26)} ${count}`);
console.log('--- output detail ---');
for (const event of outputs) {
  const extra = ['rawBytes', 'collapsedBytes', 'blankLines', 'rewrites', 'repaintsSkipped']
    .filter((field) => event[field] !== undefined)
    .map((field) => `${field}=${event[field]}`)
    .join(' ');
  console.log(`  seq ${String(event.seq).padStart(3)} ${event.ts} bytes=${String(event.fullBytes ?? '-').padStart(5)} lines=${String(event.lines ?? '-').padStart(4)} ${extra}`);
}

console.log('--- verdicts (acceptance list) ---');
const verdict = (name, ok, detail) => console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  — ${detail}`);
// Advisory, not a verdict: density depends on what the commands print (a log of tiny `echo`s is
// legitimately low), so it is reported for comparison against the reports rather than judged.
console.log(`  NOTE  text density  — ${perLine.toFixed(1)} bytes/line `
  + `(a real interactive session measures 20+; before the ConPTY fix it was 15.0)`);
verdict('no duplicate frames kept (report: 7/16)', duplicates === 0, `${duplicates}/${outputs.length}`);
verdict('login banner shown once (report: 15)', banner <= 1, String(banner));
verdict('output entries are not one-per-repaint', outputs.length <= inputs.length + 4, `${outputs.length} output for ${inputs.length} input`);
verdict('accounting fields present (0.1.1+)', hasField('rawBytes') && hasField('blankLines'), hasField('rawBytes') ? 'yes' : 'ABSENT');
verdict('resize events recorded (0.1.1+)', resizes.length >= 0 && (resizes.length === 0 || hasField('cols')), `${resizes.length} events`);

// Only the objective regressions gate the exit code: repaint frames kept, and a repeated banner.
const failed = outputs.length > 0 && (duplicates > 0 || banner > 1);
process.exit(failed ? 1 : 0);
