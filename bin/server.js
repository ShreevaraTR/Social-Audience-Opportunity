#!/usr/bin/env node
// Usage: node bin/server.js   (PORT and HOST env vars optional; defaults 3000 / 127.0.0.1)
// Behind an HTTP proxy, run with NODE_USE_ENV_PROXY=1 (see README).

import { createServer } from '../src/server.js';

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '127.0.0.1';

createServer().listen(port, host, () => {
  console.log(`Beehiiv Audience Opportunity running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`);
  // Only whether search is configured - never the credential itself.
  console.log(`Brave Search API: ${process.env.BRAVE_SEARCH_API_KEY ? 'configured (server-side)' : 'not configured - search fallback disabled'}`);
});
