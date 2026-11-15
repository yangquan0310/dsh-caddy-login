import test from 'node:test';
import assert from 'node:assert/strict';
import { createSite, replaceSite, restoreSite, MARKER } from '../src/caddy-config.js';

const origin = 'https://101.43.20.69:19857';
const prefix = '/g1kjxtdflotp82awdzrrza6h/';
const existing = `{
 admin off
}
https://other.example {\n respond "a { quoted brace }"\n}
${origin} {
 tls {\n  issuer acme {\n   profile shortlived\n  }\n }
 handle {\n  reverse_proxy 127.0.0.1:3080\n }
}
`;

test('replaces only the selected site and restores it around unrelated edits', () => {
  const result = replaceSite(existing, origin, '/private/site.caddy');
  assert.ok(result.main.includes('https://other.example'));
  assert.ok(result.main.includes(MARKER));
  assert.ok(!result.main.includes('reverse_proxy'));
  const edited = '# user note\n' + result.main;
  assert.equal(restoreSite(edited, result.originalSite, result.block), '# user note\n' + existing);
});

test('refuses duplicate sites, missing sites and modified owned blocks', () => {
  assert.throws(() => replaceSite(existing + `${origin} {\n}\n`, origin, '/private/site.caddy'));
  assert.throws(() => replaceSite(existing, 'https://absent.example', '/private/site.caddy'));
  const result = replaceSite(existing, origin, '/private/site.caddy');
  assert.throws(() => restoreSite(result.main.replace('site.caddy', 'changed.caddy'), result.originalSite, result.block));
});

test('rejects credentials, authority and configuration injection', () => {
  const valid = { publicUrl: origin + prefix, upstream: 'http://127.0.0.1:3080', username: 'yangquan0310', passwordHash: '$2a$14$' + 'A'.repeat(53), token: 'test-token' };
  for (const changes of [{ username: 'admin\nrespond 200' }, { token: 'x\n}' }, { publicUrl: 'http://public.example/' }, { upstream: 'http://public.example:3080' }, { passwordHash: 'plaintext' }, { publicUrl: origin + '/bad{path}/' }]) {
    assert.throws(() => createSite({ ...valid, ...changes }));
  }
});

test('retains existing TLS and creates a protected server-side bootstrap', () => {
  const result = replaceSite(existing, origin, '/private/site.caddy');
  const site = createSite({ publicUrl: origin + prefix, upstream: 'http://127.0.0.1:3080', username: 'yangquan0310', passwordHash: '$2a$14$' + 'A'.repeat(53), token: 'test-token', originalSite: result.originalSite });
  assert.match(site, /profile shortlived/);
  assert.match(site, /basic_auth/);
  assert.match(site, /header_up -Authorization/);
  assert.match(site, /handle_response/);
  assert.match(site, /Secure/);
  assert.ok(!site.match(/redir[^\n]*test-token/));
});
