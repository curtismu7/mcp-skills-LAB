// Safety rules. Pure functions plus two tiny middlewares (plain node:http, no framework).
//  1. Loopback bind only unless SKILLS_LAB_BIND is set on purpose (the container sets it; compose publishes on 127.0.0.1 only).
//  2. Host header must be a loopback name (DNS-rebinding defence), or a name in LAB_ALLOWED_HOSTS (the shared lab-proxy).
//  3. A write must be same-origin: a cross-origin Origin, or a cross-site Sec-Fetch-Site, is refused.
//  4. The port is in the packed range 7800-7999 and never one of the forbidden ones. This app's own port is 7807.

export function isLoopbackHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(h);
}

export function bindHost(env = process.env) { return env.SKILLS_LAB_BIND || '127.0.0.1'; }

export function assertBindAllowed(host, env = process.env) {
  if (isLoopbackHost(host) || env.SKILLS_LAB_BIND) return host;
  throw new Error(`refusing to bind ${host}: loopback only. Set SKILLS_LAB_BIND to opt in (the container does; compose publishes on 127.0.0.1 only).`);
}

export const PORT_MIN = 7800;
export const PORT_MAX = 7999;
export const DEFAULT_PORT = 7807;
const FORBIDDEN_PORTS = new Set([8080, 5173, 3000, 3900, 4000, 4400, 4510, 4600, 4601, 4840, 18080, 19080, 19090]);
export function portProblem(port) {
  if (!Number.isInteger(port)) return 'PORT is not an integer';
  if (FORBIDDEN_PORTS.has(port)) return `port ${port} is reserved for something else`;
  if (port < PORT_MIN || port > PORT_MAX) return `port ${port} is outside ${PORT_MIN}-${PORT_MAX}`;
  return null;
}
export function resolvePort(env = process.env) {
  const port = env.PORT === undefined || env.PORT === '' ? DEFAULT_PORT : Number(env.PORT);
  const problem = portProblem(port);
  if (problem) throw new Error(problem);
  return port;
}

function hostOf(rawHost) {
  const raw = String(rawHost || '');
  return (raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.replace(/:\d+$/, '')).toLowerCase();
}
const extraHosts = (env) => String(env.LAB_ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/** Returns null when the Host header is acceptable, else a short reason. */
export function hostProblem(headers, env = process.env) {
  const host = hostOf(headers.host);
  if (isLoopbackHost(host) || extraHosts(env).includes(host)) return null;
  return 'Host must be a loopback name';
}

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/**
 * Returns null when a write is same-origin (or the request is not a write), else a short reason.
 * Behind the shared lab-proxy the browser's Origin is the proxy's (https://local.ping-devops.com:8443) while Host is this lab's own
 * name. The proxy sets X-Forwarded-Host / X-Forwarded-Proto; they are believed ONLY when Host is a name the operator listed in
 * LAB_ALLOWED_HOSTS (loopback does not count), so a request that did not come through the proxy cannot use them.
 */
export function crossOriginProblem(method, headers, env = process.env) {
  if (!WRITE.has(method)) return null;
  const site = headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return 'writes must be same-origin';
  const origin = headers.origin;
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host.toLowerCase() === String(headers.host || '').toLowerCase(); } catch { /* malformed */ }
    if (!ok && extraHosts(env).includes(hostOf(headers.host))) {
      const xfh = String(headers['x-forwarded-host'] || '').trim().toLowerCase();
      const xfp = String(headers['x-forwarded-proto'] || 'https').trim().toLowerCase();
      ok = xfh !== '' && (xfp === 'https' || xfp === 'http') && origin.toLowerCase() === `${xfp}://${xfh}`;
    }
    if (!ok) return 'writes must be same-origin';
  }
  return null;
}
