import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSite } from '../src/caddy-config.js';
import { hashPassword } from '../src/commands.js';

const binary = process.env.CADDY_TEST_BINARY;
test('real Caddy authenticates and bootstraps native sessions for mounted and root URLs', { skip: !binary }, async t => {
  const seen = [];
  const backend = http.createServer((req, res) => {
    seen.push(req.headers);
    if (req.url === '/?token=fixture-token') {
      res.writeHead(303, { 'set-cookie': 'dsh_session=valid; Path=/; HttpOnly', location: './' });
      res.end();
    } else if (req.headers.cookie?.includes('dsh_session=valid')) {
      res.end('authenticated ' + req.url);
    } else {
      res.writeHead(401);
      res.end('authentication required');
    }
  });
  backend.on('upgrade', (req, socket) => {
    if (!req.headers.cookie?.includes('dsh_session=valid') || req.headers.authorization) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  t.after(() => new Promise(resolve => backend.close(resolve)));
  const hash = await hashPassword('fixture-password', binary);
  for (const prefix of ['/gui/', '/']) {
    const probe = net.createServer().listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const directory = await mkdtemp(join(tmpdir(), 'dsh-caddy-http-'));
    const config = join(directory, 'Caddyfile');
    const site = createSite({
      publicUrl: 'https://localhost:' + port + prefix,
      upstream: 'http://127.0.0.1:' + backend.address().port,
      username: 'fixture-user', passwordHash: hash, token: 'fixture-token',
      originalSite: 'https://localhost:' + port + ' {\n tls internal\n}',
    });
    await writeFile(config, '{\n admin off\n auto_https disable_redirects\n skip_install_trust\n}\n' + site);
    const child = spawn(binary, ['run', '--config', config, '--adapter', 'caddyfile'], { windowsHide: true, stdio: 'ignore' });
    const exited = once(child, 'exit');
    const request = (path, headers = {}) => new Promise((resolve, reject) => {
      const req = https.get({ hostname: '127.0.0.1', servername: 'localhost', port, path, rejectUnauthorized: false, headers: { host: 'localhost:' + port, ...headers } }, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode }); });
      req.on('error', reject);
      req.setTimeout(2000, () => req.destroy(new Error('Test HTTPS request timed out')));
    });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { await request(prefix); ready = true; break; } catch { await delay(100); }
      }
      assert.ok(ready, 'Caddy starts');
      assert.equal((await request(prefix)).status, 401);
      assert.equal((await request(prefix, { authorization: 'Basic ' + Buffer.from('fixture-user:wrong').toString('base64') })).status, 401);
      const authorization = 'Basic ' + Buffer.from('fixture-user:fixture-password').toString('base64');
      const first = await request(prefix, { authorization });
      assert.equal(first.status, 303);
      assert.equal(first.headers.location, prefix + '_dsh_caddy_login');
      const exchange = await request(first.headers.location, { authorization });
      assert.equal(exchange.status, 303);
      assert.equal(exchange.headers.location, prefix);
      assert.ok(!exchange.headers.location.includes('token'));
      const setCookie = exchange.headers['set-cookie'][0];
      assert.ok(setCookie.includes('Path=' + prefix + '; Secure'));
      const cookie = setCookie.split(';')[0];
      assert.equal((await request(prefix, { authorization, cookie })).status, 200);
      assert.equal((await request(prefix + 'api/test', { authorization, cookie })).body, 'authenticated /api/test');
      assert.equal((await request(prefix, { authorization, cookie: 'dsh_session=expired' })).status, 303);
      const upgraded = await request(prefix + 'socket', { authorization, cookie, connection: 'Upgrade', upgrade: 'websocket' });
      assert.equal(upgraded.status, 101);
      assert.ok(seen.every(headers => !headers.authorization));
    } finally {
      child.kill();
      await exited;
    }
  }
});
