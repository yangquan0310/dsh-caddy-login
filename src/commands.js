import { spawn } from 'node:child_process';

export function runCommand(command, args, input) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'SystemRoot', 'SYSTEMROOT', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let tooLarge = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', data => {
      output += data;
      if (output.length > 1024 * 1024) { tooLarge = true; child.kill(); }
    });
    // Caddy diagnostics can contain configuration values. Drain them without
    // forwarding their content to logs or callers.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('Required server command could not start')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || tooLarge) reject(new Error('Required server command failed'));
      else resolve(output.trim());
    });
    child.stdin.end(input);
  });
}

export async function hashPassword(password, binary = 'caddy') {
  if (typeof password !== 'string' || password.length === 0 || /[\r\n\0]/.test(password)) {
    throw new Error('Login password must be a nonempty, single-line credential');
  }
  // Standard input avoids credentials appearing in the process command line.
  const hash = await runCommand(binary, ['hash-password'], password);
  if (!/^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/.test(hash)) throw new Error('Caddy returned an invalid password hash');
  return hash;
}
