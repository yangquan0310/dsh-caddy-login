export const MARKER = '# BEGIN dsh-caddy-login';
const END = '# END dsh-caddy-login';

// Caddy block delimiters are standalone tokens. Quoted strings, comments and
// placeholders such as {http.request.host} must not affect block depth.
function blocks(text) {
  const found = [];
  let depth = 0;
  let quoted = false;
  let comment = false;
  let escaped = false;
  let start = 0;
  let opening = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (comment) { if (char === '\n') comment = false; continue; }
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && quoted) { escaped = true; continue; }
    if (char === '"' || char === '`') {
      if (!quoted) quoted = char;
      else if (quoted === char) quoted = false;
      continue;
    }
    if (quoted) continue;
    if (char === '#') { comment = true; continue; }
    if (!'{}'.includes(char)) continue;
    if (i > 0 && !/\s/.test(text[i - 1])) continue;
    if (i + 1 < text.length && !/[\s#]/.test(text[i + 1])) continue;
    if (char === '{') {
      if (depth === 0) {
        start = text.lastIndexOf('\n', i - 1) + 1;
        opening = i;
      }
      depth++;
    } else {
      depth--;
      if (depth < 0) throw new Error('Unbalanced Caddy configuration');
      if (depth === 0) found.push({ start, opening, end: i + 1, header: text.slice(start, opening).trim() });
    }
  }
  if (depth !== 0 || quoted) throw new Error('Unbalanced Caddy configuration');
  return found;
}

export function replaceSite(main, origin, fragmentPath) {
  if (main.includes(MARKER) || main.includes(END)) throw new Error('Caddy configuration already has a managed site');
  const matches = blocks(main).filter(block => block.header === origin);
  if (matches.length !== 1) throw new Error('Expected one existing, single-address Caddy HTTPS site');
  const block = `${MARKER}\nimport ${JSON.stringify(fragmentPath.replaceAll('\\', '/'))}\n${END}`;
  const match = matches[0];
  return { main: main.slice(0, match.start) + block + main.slice(match.end), block, originalSite: main.slice(match.start, match.end) };
}

export function restoreSite(main, originalSite, block) {
  if (main.split(block).length !== 2) throw new Error('Managed Caddy block changed externally');
  return main.replace(block, originalSite);
}

export function createSite({ publicUrl, upstream, username, passwordHash, token, originalSite = '', unavailable = false }) {
  const url = new URL(publicUrl);
  const backend = new URL(upstream);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9_/-]*\/$|^\/$/.test(url.pathname)) {
    throw new Error('publicUrl must be a clean HTTPS root or directory URL');
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(username)) throw new Error('Invalid login username');
  if (!unavailable && !/^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/.test(passwordHash)) throw new Error('Invalid bcrypt password hash');
  if (!unavailable && !/^[A-Za-z0-9_-]{1,1024}$/.test(token)) throw new Error('Invalid process token');
  if (!['http:', 'https:'].includes(backend.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(backend.hostname) || backend.username || backend.password || backend.pathname !== '/' || backend.search || backend.hash) {
    throw new Error('DSH upstream must be a loopback origin');
  }
  let tls = '';
  if (originalSite) {
    const site = blocks(originalSite)[0];
    const body = originalSite.slice(site.opening + 1, site.end - 1);
    const tlsBlock = blocks(body).find(block => block.header === 'tls' || block.header.startsWith('tls '));
    if (tlsBlock) tls = body.slice(tlsBlock.start, tlsBlock.end);
    // Existing sites with single-line TLS certificate directives also work.
    if (!tls) tls = body.split('\n').find(line => /^\s*tls\s+[^\s{]/.test(line)) ?? '';
  }
  if (unavailable) return `${url.origin} {\n${tls}\n respond "Login credential unavailable" 503\n}\n`;
  const prefix = url.pathname;
  const mount = prefix === '/' ? '/' : prefix.slice(0, -1);
  const proxy = `reverse_proxy ${backend.origin} {\n    header_up -Authorization\n    header_down Set-Cookie "Path=/" ${JSON.stringify(`Path=${prefix}; Secure`)}\n    header_down Location "^([.]/|/)$" ${JSON.stringify(prefix)}\n`;
  const unmounted = prefix === '/' ? 'handle' : `handle_path ${prefix}*`;
  const redirects = prefix === '/' ? '' : `redir / ${prefix} 302\n  redir ${mount} ${prefix} 308\n`;
  return `${url.origin} {\n${tls}\n route {\n  basic_auth {\n   ${username} ${passwordHash}\n  }\n  ${redirects}  ${unmounted} {\n   @bootstrap path /_dsh_caddy_login\n   handle @bootstrap {\n    rewrite * /?token=${token}\n    ${proxy}   }\n   }\n   @document path / /index.html\n   handle @document {\n    ${proxy}    @unauthorized status 401\n    handle_response @unauthorized {\n     redir * ${prefix}_dsh_caddy_login 303\n    }\n    }\n   }\n   handle {\n    ${proxy}   }\n   }\n  }\n  handle {\n   respond "Not Found" 404\n  }\n }\n}\n`;
}
