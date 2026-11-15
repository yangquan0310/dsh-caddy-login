import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { CaddyManager } from '../src/caddy-manager.js';

const site = 'https://example.test:19857 {\n tls internal\n reverse_proxy 127.0.0.1:3080\n}\n';
const values = { publicUrl: 'https://example.test:19857/gui/', upstream: 'http://127.0.0.1:3080', username: 'yangquan0310', passwordHash: '$2a$14$' + 'A'.repeat(53), token: 'first-token' };

async function fixture(run = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-caddy-manager-'));
  const caddyfile = join(root, 'Caddyfile');
  await writeFile(caddyfile, site);
  const options = { caddyfile, stateDirectory: join(root, 'state'), run };
  return { root, caddyfile, options, manager: new CaddyManager(options) };
}

test('installs, updates and restores without overwriting unrelated changes', async () => {
  const f = await fixture();
  await f.manager.update(values);
  const main = await readFile(f.caddyfile, 'utf8');
  assert.ok(main.includes('# BEGIN dsh-caddy-login'));
  assert.ok(!main.includes(values.token));
  await f.manager.update({ ...values, token: 'second-token' });
  assert.match(await readFile(f.manager.fragmentPath, 'utf8'), /second-token/);
  await writeFile(f.caddyfile, '# external note\n' + main);
  await f.manager.restore();
  assert.equal(await readFile(f.caddyfile, 'utf8'), '# external note\n' + site);
});

test('validation failure preserves the original site and does not restart Caddy', async () => {
  const events = [];
  const f = await fixture(async (command, args) => {
    events.push(command);
    if (args[0] === 'validate') throw new Error('invalid');
  });
  await assert.rejects(f.manager.update(values));
  assert.equal(await readFile(f.caddyfile, 'utf8'), site);
  assert.deepEqual(events, ['caddy']);
});

test('changes made during candidate validation prevent commit', async () => {
  let f;
  f = await fixture(async (command, args) => {
    if (args[0] === 'validate') await writeFile(f.caddyfile, '# concurrent edit\n' + site);
  });
  await assert.rejects(f.manager.update(values), /changed during/);
  assert.equal(await readFile(f.caddyfile, 'utf8'), '# concurrent edit\n' + site);
});

test('a stale empty legacy lock cannot prevent transaction recovery', async () => {
  const f = await fixture();
  await mkdir(f.options.stateDirectory);
  await writeFile(f.manager.lockPath, '');
  await f.manager.update(values);
  await f.manager.restore();
  assert.equal(await readFile(f.caddyfile, 'utf8'), site);
});

test('an OS lock excludes another process and releases after abrupt termination', async () => {
  let validating = false;
  const f = await fixture(async (command, args) => { if (args[0] === 'validate') validating = true; });
  await mkdir(f.options.stateDirectory);
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN EXCLUSIVE'); console.log('locked'); process.stdin.resume();",
    f.manager.lockPath], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  await once(child.stdout, 'data');
  const updating = f.manager.update(values);
  await delay(100);
  assert.equal(validating, false);
  child.kill('SIGKILL');
  await once(child, 'exit');
  await updating;
  assert.equal(validating, true);
  await f.manager.restore();
});

test('reload failure restores disk state and reloads the previous site', async () => {
  let restarts = 0;
  const f = await fixture(async (command) => {
    if (command === 'systemctl' && ++restarts === 1) throw new Error('failed restart');
  });
  await assert.rejects(f.manager.update(values));
  assert.equal(await readFile(f.caddyfile, 'utf8'), site);
  assert.equal(restarts, 2);
});

test('a stale scope cannot restore over a newer scope and live other processes cannot take ownership', async () => {
  const f = await fixture();
  await f.manager.update(values);
  const newer = new CaddyManager(f.options);
  await newer.update({ ...values, token: 'new-owner' });
  await f.manager.restore();
  assert.match(await readFile(newer.fragmentPath, 'utf8'), /new-owner/);
  const differentProcess = new CaddyManager({ ...f.options, pid: process.pid + 1, isAlive: () => true });
  await assert.rejects(differentProcess.update(values), /another process/);
  await newer.restore();
});

test('external changes to the fragment block automatic updates and restoration', async () => {
  const f = await fixture();
  await f.manager.update(values);
  await writeFile(f.manager.fragmentPath, '# user changed it\n');
  await assert.rejects(f.manager.update(values), /changed externally/);
  await assert.rejects(f.manager.restore(), /changed externally/);
  assert.match(await readFile(f.caddyfile, 'utf8'), /BEGIN dsh-caddy-login/);
});

test('parallel updates are serialized and interrupted writes recover before the next operation', async () => {
  const f = await fixture();
  await Promise.all([f.manager.update(values), f.manager.update({ ...values, token: 'final-token' })]);
  assert.match(await readFile(f.manager.fragmentPath, 'utf8'), /final-token/);
  const statePath = join(f.options.stateDirectory, 'state.json');
  const previous = await readFile(statePath, 'utf8');
  const currentMain = await readFile(f.caddyfile, 'utf8');
  const fragment = await readFile(f.manager.fragmentPath, 'utf8');
  const journal = {
    version: 1,
    entries: [
      { path: f.caddyfile, before: currentMain, after: 'interrupted', mode: 384 },
      { path: f.manager.fragmentPath, before: fragment, after: 'bad fragment', mode: 384 },
      { path: statePath, before: previous, after: null, mode: 384 },
    ],
  };
  await writeFile(join(f.options.stateDirectory, 'journal.json'), JSON.stringify(journal));
  await writeFile(f.caddyfile, 'interrupted');
  await writeFile(f.manager.fragmentPath, 'bad fragment');
  await f.manager.update({ ...values, token: 'recovered' });
  assert.match(await readFile(f.manager.fragmentPath, 'utf8'), /recovered/);
  await f.manager.restore();
  assert.equal(await readFile(f.caddyfile, 'utf8'), site);
});
