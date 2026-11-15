import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { open, readFile, lstat, mkdir, chmod, chown, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSite, replaceSite, restoreSite } from './caddy-config.js';
import { runCommand } from './commands.js';

const digest = text => createHash('sha256').update(text).digest('hex');
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
};

async function snapshot(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Managed path must be a regular file');
    return { path, before: await readFile(path, 'utf8'), mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid };
  } catch (error) {
    if (error.code === 'ENOENT') return { path, before: null, mode: 0o600 };
    throw error;
  }
}

async function remove(path) {
  try { await unlink(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function atomic(path, content, metadata = {}) {
  if (content === null) return remove(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.tmp-' + randomUUID();
  const file = await open(temporary, 'wx', metadata.mode ?? 0o600);
  try {
    await file.writeFile(content);
    if (process.platform !== 'win32' && metadata.gid !== undefined) {
      await file.chown(metadata.uid ?? process.getuid(), metadata.gid);
    }
    await file.sync();
  } finally { await file.close(); }
  try { await rename(temporary, path); }
  finally { await remove(temporary); }
}

export class CaddyManager {
  constructor({ caddyfile, stateDirectory, run = runCommand, caddyBinary = 'caddy', groupId, pid = process.pid, isAlive = alive }) {
    this.caddyfile = resolve(caddyfile);
    this.stateDirectory = resolve(stateDirectory);
    this.fragmentPath = join(dirname(this.caddyfile), 'dsh-caddy-login', 'site.caddy');
    this.statePath = join(this.stateDirectory, 'state.json');
    this.journalPath = join(this.stateDirectory, 'journal.json');
    this.lockPath = join(this.stateDirectory, 'transaction.lock');
    this.run = run;
    this.binary = caddyBinary;
    this.groupId = groupId;
    this.pid = pid;
    this.isAlive = isAlive;
    this.owner = randomUUID();
    this.pending = Promise.resolve();
  }

  withLock(operation) {
    const result = this.pending.then(() => this.locked(operation));
    this.pending = result.catch(() => {});
    return result;
  }

  async locked(operation) {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(this.stateDirectory, 0o700);
    // SQLite uses operating-system locks. Process exit releases ownership,
    // including exits before journal recovery or during a configuration write.
    await snapshot(this.lockPath);
    const database = new DatabaseSync(this.lockPath);
    const deadline = Date.now() + 30_000;
    let acquired = false;
    try {
      if (process.platform !== 'win32') await chmod(this.lockPath, 0o600);
      while (!acquired) {
        try {
          database.exec('BEGIN EXCLUSIVE');
          acquired = true;
        } catch (error) {
          if (!/locked|busy/i.test(error.message)) throw new Error('Caddy transaction lock is unavailable');
          if (Date.now() > deadline) throw new Error('Another Caddy configuration transaction is still running');
          await delay(25);
        }
      }
      await this.recover();
      return await operation();
    } finally {
      if (acquired) database.exec('ROLLBACK');
      database.close();
    }
  }
  async recover() {
    const pending = await snapshot(this.journalPath);
    if (pending.before === null) return;
    const journal = JSON.parse(pending.before);
    const allowed = [this.caddyfile, this.fragmentPath, this.statePath];
    if (journal.version !== 1 || journal.entries.length !== 3 || new Set(journal.entries.map(x => x.path)).size !== 3 || journal.entries.some(x => !allowed.includes(x.path))) {
      throw new Error('Invalid recovery journal');
    }
    for (const entry of journal.entries) {
      const current = await snapshot(entry.path);
      if (current.before !== entry.before && current.before !== entry.after) {
        throw new Error('Interrupted Caddy configuration changed externally');
      }
    }
    for (const entry of journal.entries) await atomic(entry.path, entry.before, entry);
    await this.run('systemctl', ['restart', 'caddy.service']);
    await remove(this.journalPath);
  }

  async validate(main, fragment) {
    const candidateMain = join(dirname(this.caddyfile), '.dsh-caddy-check-' + randomUUID());
    const candidateFragment = this.fragmentPath + '.check-' + randomUUID();
    try {
      if (fragment !== null) await atomic(candidateFragment, fragment, { mode: 0o640, gid: this.groupId });
      const text = fragment === null ? main : main.replace(JSON.stringify(this.fragmentPath.replaceAll('\\', '/')), JSON.stringify(candidateFragment.replaceAll('\\', '/')));
      await atomic(candidateMain, text);
      await this.run(this.binary, ['validate', '--config', candidateMain, '--adapter', 'caddyfile']);
    } finally {
      await remove(candidateMain);
      await remove(candidateFragment);
    }
  }

  async commit(main, fragment, state, baseline) {
    const entries = await Promise.all([this.caddyfile, this.fragmentPath, this.statePath].map(snapshot));
    if (entries.some((entry, index) => entry.before !== baseline[index].before)) {
      throw new Error('Caddy configuration changed during validation');
    }
    entries[0].after = main;
    entries[1].after = fragment;
    entries[1].mode = 0o640;
    entries[1].gid = this.groupId ?? entries[1].gid;
    entries[2].after = state === null ? null : JSON.stringify(state, null, 2);
    await atomic(this.journalPath, JSON.stringify({ version: 1, entries }));
    try {
      // The main file must never point at a fragment that has not been written.
      await atomic(this.fragmentPath, fragment, entries[1]);
      await atomic(this.caddyfile, main, entries[0]);
      await atomic(this.statePath, entries[2].after, entries[2]);
      await this.run('systemctl', ['restart', 'caddy.service']);
      await remove(this.journalPath);
    } catch {
      for (const entry of entries) await atomic(entry.path, entry.before, entry);
      try {
        await this.run('systemctl', ['restart', 'caddy.service']);
        await remove(this.journalPath);
      } catch { throw new Error('Caddy update failed; disk configuration restored but Caddy restart needs recovery'); }
      throw new Error('Caddy update failed and was rolled back');
    }
  }

  async readOwned() {
    const stateFile = await snapshot(this.statePath);
    if (stateFile.before === null) return undefined;
    const state = JSON.parse(stateFile.before);
    if (state.version !== 1 || typeof state.block !== 'string' || typeof state.originalSite !== 'string' || typeof state.origin !== 'string') {
      throw new Error('Invalid Caddy ownership state');
    }
    const fragment = await snapshot(this.fragmentPath);
    if (fragment.before === null || digest(fragment.before) !== state.fragmentHash) throw new Error('Managed Caddy fragment changed externally');
    const main = await readFile(this.caddyfile, 'utf8');
    restoreSite(main, state.originalSite, state.block);
    return { state, main };
  }

  async update(values) {
    return this.withLock(async () => {
      const baseline = await Promise.all([this.caddyfile, this.fragmentPath, this.statePath].map(snapshot));
      const origin = new URL(values.publicUrl).origin;
      const owned = await this.readOwned();
      let state;
      let main;
      if (owned) {
        state = owned.state;
        main = owned.main;
        if (state.origin !== origin) throw new Error('Restore the current managed site before changing public origin');
        if (state.ownerPid !== this.pid && this.isAlive(state.ownerPid)) throw new Error('Caddy login is owned by another process');
      } else {
        const replaced = replaceSite(await readFile(this.caddyfile, 'utf8'), origin, this.fragmentPath);
        main = replaced.main;
        state = { version: 1, origin, originalSite: replaced.originalSite, block: replaced.block };
        const backup = join(this.stateDirectory, 'original-site-' + randomUUID() + '.caddy');
        await atomic(backup, replaced.originalSite);
      }
      const fragment = createSite({ ...values, originalSite: state.originalSite });
      await mkdir(dirname(this.fragmentPath), { recursive: true, mode: 0o750 });
      if (process.platform !== 'win32') {
        await chmod(dirname(this.fragmentPath), 0o750);
        if (this.groupId !== undefined) await chown(dirname(this.fragmentPath), process.getuid(), this.groupId);
      }
      await this.validate(main, fragment);
      await this.commit(main, fragment, { ...state, fragmentHash: digest(fragment), ownerPid: this.pid, ownerId: this.owner }, baseline);
    });
  }

  async restore() {
    return this.withLock(async () => {
      const baseline = await Promise.all([this.caddyfile, this.fragmentPath, this.statePath].map(snapshot));
      const stateFile = await snapshot(this.statePath);
      if (stateFile.before === null) return;
      // A newer hot-reload scope owns cleanup once it has claimed the state.
      if (JSON.parse(stateFile.before).ownerId !== this.owner) return;
      const { main, state } = await this.readOwned();
      const restored = restoreSite(main, state.originalSite, state.block);
      await this.validate(restored, null);
      await this.commit(restored, null, null, baseline);
    });
  }
}
