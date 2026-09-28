// Vercel serverless entry point. The same request handler as the local server
// (src/server.js createApp); vercel.json serves public/ statically and rewrites
// /api/* here.

import { createApp } from '../src/server.js';

const app = createApp();

export default function handler(req, res) {
  // vercel.json rewrites /api/:path* to /api/index?__path=:path*. Depending on the
  // runtime, req.url is the original URL or the rewritten one; normalise both to
  // /api/<path> so the shared router sees the same URLs as locally.
  const url = new URL(req.url, 'http://localhost');
  const path = url.searchParams.get('__path');
  url.searchParams.delete('__path');
  if (path !== null) url.pathname = `/api/${path}`;
  req.url = url.pathname + url.search;
  return app(req, res);
}
