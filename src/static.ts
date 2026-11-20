import { createReadStream, statSync } from 'node:fs';
import type http from 'node:http';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
};
// No inline scripts/styles anywhere: a strict CSP is the main XSS defence for the web UI.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
  "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** Serve files under `root` at URL prefix `/app`. Returns false if the request is not for the UI. */
export function serveUi(root: string, req: http.IncomingMessage, res: http.ServerResponse, pathname: string, production: boolean): boolean {
  if (pathname === '/') { res.writeHead(302, { location: '/app/' }); res.end(); return true; }
  if (pathname === '/app') { res.writeHead(302, { location: '/app/' }); res.end(); return true; }
  if (!pathname.startsWith('/app/')) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return true; }
  let rel: string;
  try { rel = decodeURIComponent(pathname.slice('/app/'.length)) || 'index.html'; } catch { res.writeHead(400); res.end(); return true; }
  const file = path.resolve(root, rel);
  if (!file.startsWith(path.resolve(root) + path.sep) || rel.includes('\0')) { res.writeHead(404); res.end(); return true; }   // path traversal guard
  let st; try { st = statSync(file); } catch { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return true; }
  if (!st.isFile()) { res.writeHead(404); res.end(); return true; }
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-cache',
    'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
    ...(production ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
  });
  if (req.method === 'HEAD') res.end(); else createReadStream(file).pipe(res);
  return true;
}
