// Serves the built web app (web/dist). GET/HEAD only, exact files only (no directory listing, no SPA fallback beyond "/"), path traversal impossible:
// the request path is decoded once, normalised and must stay under the dist folder.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json' };
// React Flow sets inline styles, hence 'unsafe-inline' for styles only. No inline script, no remote origin of any kind.
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export async function serveStatic(req, dist = WEB_DIST) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  let rel;
  try { rel = decodeURIComponent(new URL(req.url).pathname); } catch { return null; }
  if (rel.includes('\0') || rel.includes('\\')) return null;
  if (rel === '/') rel = '/index.html';
  const file = path.resolve(dist, `.${path.posix.normalize(rel)}`);
  if (file !== dist && !file.startsWith(dist + path.sep)) return null;
  let st;
  try { st = await fs.promises.stat(file); } catch { return null; }
  if (!st.isFile()) return null;
  const ext = path.extname(file).toLowerCase();
  const html = ext === '.html';
  const headers = {
    'content-type': MIME[ext] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'cache-control': html ? 'no-cache' : 'public, max-age=3600',
    ...(html ? { 'content-security-policy': CSP } : {}),
  };
  const body = req.method === 'HEAD' ? null : await fs.promises.readFile(file);
  return new Response(body, { status: 200, headers });
}
