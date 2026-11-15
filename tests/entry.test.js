import test from 'node:test';
import assert from 'node:assert/strict';
import { Config, apply } from '../src/index.js';

test('the default credential reference works outside the reserved DSH prefix', () => {
  const config = Config({});
  assert.equal(config.password, 'CADDY_LOGIN_PASSWORD');
  assert.equal(config.username, '');
});

test('an unconfigured installed plugin stays idle', async () => {
  await apply({}, Config({}));
});
