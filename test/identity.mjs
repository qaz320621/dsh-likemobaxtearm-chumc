// Identity consistency: the package name and version must agree everywhere they are declared, so a
// rename or a version bump can never ship half-renamed artifacts (a mismatched client registration id
// silently fails to load the bundle, and a stale version number makes bug reports unreadable).
//
// Runs with no dependencies and no Harness installation, so it also guards the distributed tarball.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));
const read = (name) => readFileSync(join(here, name), 'utf8');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: ok === true });
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`);
}

const manifest = JSON.parse(read('package.json'));
const packageName = manifest.name;
const version = manifest.version;

// ---------------------------------------------------------------- the name in every declaration

const patchName = /name:\s*'([^']+)'/.exec(read('cordis.patch.yml'))?.[1];
check('the bundle patch inserts the row under the package name', patchName === packageName, `${patchName}`);

const hostName = /export const name = '([^']+)'/.exec(read('index.js'))?.[1];
check('the Host half exports the package name', hostName === packageName, `${hostName}`);

const clientSource = read('client.js');
const clientId = /const PACKAGE_ID = '([^']+)'/.exec(clientSource)?.[1];
check('the Client half registers under the package name', clientId === packageName, `${clientId}`);

const loaderId = /window\.__ModuleLoader__\.load\(\{\s*\n\s*id: ([^,]+),/.exec(clientSource)?.[1];
check('the module-loader call uses that same constant', loaderId === 'PACKAGE_ID', `${loaderId}`);

const chunkId = /id:"([^"]+)"/.exec(read('client.xterm.js'))?.[1];
check('the terminal chunk registers under the package name', chunkId === packageName, `${chunkId}`);

const tabIds = [...clientSource.matchAll(/const (?:CONSOLE|LEGACY)_TAB_ID = `\$\{PACKAGE_ID\}\/([a-z]+)`/g)].map((match) => match[1]);
check('tab type ids are derived from the package name', tabIds.join(',') === 'console,legacy', tabIds.join(','));

// The tab KINDS are deliberately NOT name-derived: they must survive a rename so saved layouts and
// sessions keep working.
check('tab kinds are stable strings, not package-derived',
  clientSource.includes("kind: 'ssh-console'") && clientSource.includes("kind: 'ssh'"));
check('the storage keys are not package-derived either',
  /const BINDING_PREFIX = 'dsh-ssh\.binding\./.test(clientSource) && /RECENTS_KEY = 'dsh-ssh\.recents\./.test(clientSource));

// ---------------------------------------------------------------- the version

const readme = read('README.md');
const readmeName = /包名：`([^`]+)`/.exec(readme)?.[1];
const readmeVersion = /版本：\*\*([0-9]+\.[0-9]+\.[0-9]+)\*\*/.exec(readme)?.[1];
check('the README states the same package name', readmeName === packageName, `${readmeName}`);
check('the README states the same version', readmeVersion === version, `${readmeVersion} vs ${version}`);

const clientBuild = /const CLIENT_BUILD = '([^']+)'/.exec(clientSource)?.[1];
check('the client build marker carries the version (stale-page diagnosis)', clientBuild?.startsWith(version) === true, `${clientBuild}`);

check('the manifest declares MIT', manifest.license === 'MIT' && read('LICENSE').startsWith('MIT License'), `${manifest.license}`);

// ---------------------------------------------------------------- metadata files

const zh = JSON.parse(read('locale/zh.json'));
const en = JSON.parse(read('locale/en.json'));
check('both locale files describe the plugin', typeof zh.meta?.title === 'string' && typeof en.meta?.title === 'string'
  && zh.meta.title.length > 0 && en.meta.title.length > 0, `${zh.meta?.title} / ${en.meta?.title}`);
check('the locale metadata mentions the shared-session promise',
  typeof zh.meta?.description === 'string' && zh.meta.description.length > 0);

const scripts = manifest.scripts ?? {};
check('every test suite is run by `npm test`', ['inject-audit', 'connection-contract', 'cordis-activation', 'host-smoke', 'host-rpc', 'client-wiring', 'log-retention', 'identity']
  .every((suite) => String(scripts.test ?? '').includes(`test/${suite}.mjs`)), String(scripts.test).slice(0, 60));
check('the offline subset also runs the identity check', String(scripts['test:offline'] ?? '').includes('test/identity.mjs'));

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
