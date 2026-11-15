import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from '../src/commands.js';

test('Caddy receives a newline-terminated password through stdin', async () => {
  const expectedHash = '$2a$14$' + 'A'.repeat(53);
  const run = async (binary, args, input) => {
    assert.equal(binary, 'caddy');
    assert.deepEqual(args, ['hash-password']);
    assert.equal(input, 'fixture-password\n');
    return expectedHash;
  };
  assert.equal(await hashPassword('fixture-password', 'caddy', run), expectedHash);
});
