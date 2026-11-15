import test from 'node:test';
import assert from 'node:assert/strict';
import { startLogin } from '../src/login.js';

function fixture() {
  let secret = 'first-password';
  let token = 'first-token';
  const writes = [];
  const services = {
    credentials: { resolve: async ref => { assert.equal(ref, 'DSH_CADDY_PASSWORD'); return secret ? { value: secret, source: 'user-env' } : undefined; } },
    authenticatedUrl: root => root + '?token=' + token,
    hash: async password => 'hashed-' + password,
    manager: { update: async value => writes.push(value), restore: async () => writes.push('restore') },
  };
  const options = { username: 'yangquan0310', password: 'DSH_CADDY_PASSWORD', publicUrl: 'https://example.test/gui/', upstream: 'http://127.0.0.1:3080', refreshIntervalMs: 60_000 };
  return { services, options, writes, setSecret: value => { secret = value; }, setToken: value => { token = value; } };
}

test('resolves the credential reference and rotates changed passwords and native tokens', async () => {
  const f = fixture();
  const login = await startLogin(f.options, f.services);
  assert.equal(f.writes[0].passwordHash, 'hashed-first-password');
  assert.equal(f.writes[0].token, 'first-token');
  assert.equal(f.writes[0].password, undefined);
  await login.refresh();
  assert.equal(f.writes.length, 1);
  f.setSecret('new-password');
  f.setToken('new-token');
  await login.refresh();
  assert.equal(f.writes[1].passwordHash, 'hashed-new-password');
  assert.equal(f.writes[1].token, 'new-token');
  await login.close();
  assert.equal(f.writes.at(-1), 'restore');
});

test('missing initial credentials fail without publishing a Caddy configuration', async () => {
  const f = fixture();
  f.setSecret('');
  await assert.rejects(startLogin(f.options, f.services), /credential/);
  assert.deepEqual(f.writes, []);
});

test('a removed credential blocks new access until a credential is restored', async () => {
  const f = fixture();
  const login = await startLogin(f.options, f.services);
  f.setSecret('');
  await login.refresh();
  assert.equal(f.writes.at(-1).unavailable, true);
  f.setSecret('first-password');
  await login.refresh();
  assert.equal(f.writes.at(-1).token, 'first-token');
  assert.equal(f.writes.at(-1).unavailable, undefined);
  await login.close();
});

test('closing during a pending refresh waits for it and prevents late installation', async () => {
  const f = fixture();
  const login = await startLogin(f.options, f.services);
  let release;
  const pendingHash = new Promise(resolve => { release = resolve; });
  f.services.hash = () => pendingHash;
  f.setSecret('different');
  const refreshing = login.refresh();
  await new Promise(resolve => setImmediate(resolve));
  const closing = login.close();
  release('late-hash');
  await Promise.all([refreshing, closing]);
  assert.equal(f.writes.length, 2);
  assert.equal(f.writes.at(-1), 'restore');
  await login.refresh();
  assert.equal(f.writes.length, 2);
});
