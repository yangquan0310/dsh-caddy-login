import { createHash } from 'node:crypto';
import { credentialRef } from '@deepseek-ai/dsh-credentials';

export async function startLogin(options, services) {
  let closed = false;
  let active = false;
  let fingerprint;
  let pending = Promise.resolve();
  const common = {
    username: options.username,
    publicUrl: options.publicUrl,
    upstream: options.upstream,
  };

  async function update() {
    if (closed) return;
    const credential = await services.credentials.resolve(credentialRef(options.password));
    if (closed) return;
    if (!credential?.value) {
      if (!active) throw new Error('Login password credential is missing');
      if (fingerprint !== 'unavailable') {
        await services.manager.update({ ...common, unavailable: true });
        fingerprint = 'unavailable';
      }
      return;
    }
    const nativeUrl = new URL(services.authenticatedUrl(options.publicUrl));
    const token = nativeUrl.searchParams.get('token');
    if (!token) throw new Error('Native web authentication token is unavailable');
    const next = createHash('sha256').update(JSON.stringify([credential.value, token])).digest('hex');
    if (next === fingerprint) return;
    const passwordHash = await services.hash(credential.value);
    if (closed) return;
    await services.manager.update({ ...common, passwordHash, token });
    active = true;
    fingerprint = next;
  }

  function refresh() {
    const work = pending.then(update);
    pending = work.catch(() => {});
    return work;
  }

  await refresh();
  const timer = setInterval(() => {
    refresh().catch(() => services.warn?.('Caddy login refresh failed'));
  }, options.refreshIntervalMs ?? 15_000);
  timer.unref();

  return {
    refresh,
    async close() {
      closed = true;
      clearInterval(timer);
      await pending;
      if (active) await services.manager.restore();
    },
  };
}
