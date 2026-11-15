import Schema from '@deepseek-ai/schemastery';
import { CaddyManager } from './caddy-manager.js';
import { hashPassword, runCommand } from './commands.js';
import { startLogin } from './login.js';

export const name = 'dsh-caddy-login';
export const inject = ['credentials', 'connection', 'webServer', 'webApp'];
export const Config = Schema.object({
  username: Schema.string().default(''),
  password: Schema.string().default('DSH_CADDY_PASSWORD'),
  publicUrl: Schema.string(),
  caddyfile: Schema.string().default('/etc/caddy/Caddyfile'),
  stateDirectory: Schema.string().default('/var/lib/dsh-caddy-login'),
  refreshIntervalMs: Schema.number().min(1000).default(15000),
});

export async function apply(ctx, config) {
  if (!config.username) return;
  if (process.platform !== 'linux') throw new Error('Caddy login requires a Linux systemd host');
  const logger = ctx.logger(name);
  const groupId = Number(await runCommand('id', ['-g', 'caddy']));
  if (!Number.isSafeInteger(groupId) || groupId < 0) throw new Error('Caddy group is unavailable');
  const manager = new CaddyManager({ ...config, groupId });
  let disposed = false;
  let login;
  ctx.effect(() => () => {
    disposed = true;
    return login?.close();
  });
  login = await startLogin({
    ...config,
    publicUrl: config.publicUrl || ctx.webApp.getAdvertisedUrl(),
    upstream: ctx.webServer.getOrigin(),
  }, {
    credentials: ctx.credentials,
    authenticatedUrl: root => ctx.connection.authenticatedUrl(root),
    hash: hashPassword,
    manager,
    warn: message => logger.warn(message),
  });
  if (disposed) {
    await login.close();
    return;
  }
  ctx.on('credentials/reference-updated', () => {
    login.refresh().catch(() => logger.warn('Caddy login refresh failed'));
  });
  logger.info('Caddy password login is active');
}

export default { name, inject, Config, apply };
