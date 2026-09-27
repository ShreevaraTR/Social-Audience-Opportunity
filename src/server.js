// Web server for the Audience Opportunity UI. Zero dependencies (node:http).
//
// The browser only ever talks to this server. Research - including every Brave Search
// API request and its credential - happens here, server-side.
//
// API
//   POST   /api/analyze                              { website } -> analysis view
//                                                    { analysisId, report, newsletterStrategy }
//   GET    /api/analyses/:id                         -> analysis view
//   PUT    /api/analyses/:id/user-counts/:platform   { count }   -> analysis view (422 on invalid)
//   DELETE /api/analyses/:id/user-counts/:platform              -> analysis view
//
// The server keeps each analysis's automated report plus the user's raw entries, and
// recomputes the view from them on every change with applyUserProvidedCounts(). The
// client never submits provenance, totals or scenarios, so it cannot turn a typed number
// into a verified one.

import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { researchCompany } from './research.js';
import { applyUserProvidedCount, applyUserProvidedCounts } from './audience.js';
import { generateNewsletterStrategy, deterministicStrategyProvider } from './newsletter.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MAX_BODY_BYTES = 16 * 1024;
const ANALYSIS_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_ANALYSES = 200;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    Object.assign(this, { status, code, extra });
  }
}

/**
 * Normalise a user-typed website into an absolute public http(s) URL. A missing scheme
 * gets https://. Local/IP targets are refused: this service fetches what it is given.
 */
export function normalizeWebsite(input) {
  if (typeof input !== 'string' || !input.trim()) throw new ApiError(400, 'INVALID_URL', 'Enter a company website, for example https://www.example.com/.');
  const raw = input.trim();
  if (raw.length > 2048) throw new ApiError(400, 'INVALID_URL', 'That website address is too long.');
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new ApiError(400, 'INVALID_URL', 'That doesn’t look like a valid website address.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(url.protocol)) throw new ApiError(400, 'INVALID_URL', 'Only http:// and https:// websites can be analyzed.');
  if (url.username || url.password) throw new ApiError(400, 'INVALID_URL', 'Website addresses with credentials are not accepted.');
  if (isIP(host) || !host.includes('.') || /(^|\.)(localhost|local|internal)$/i.test(host)) {
    throw new ApiError(400, 'INVALID_URL', 'Enter a public company website domain, such as example.com.');
  }
  url.hash = '';
  return url.toString();
}

/**
 * Last line of defence: the Brave credential must never leave the server. Research
 * output never contains it, but if a value ever did, it is replaced before sending.
 */
function redactSecrets(text) {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  return key && key.length >= 4 ? text.split(key).join('[redacted]') : text;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, redactSecrets(JSON.stringify(value)), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
}

async function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the request body as application/json.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'Request body is not valid JSON.');
  }
}

/** In-memory analyses: { report (automated only), userCounts: { platformKey: raw input } }. */
export class AnalysisStore {
  constructor({ ttlMs = ANALYSIS_TTL_MS, max = MAX_ANALYSES, now = () => Date.now() } = {}) {
    Object.assign(this, { ttlMs, max, now, entries: new Map() });
  }
  add(report) {
    this.prune();
    while (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value);
    const id = randomUUID();
    this.entries.set(id, { report, userCounts: {}, createdAt: this.now() });
    return id;
  }
  get(id) {
    this.prune();
    const entry = this.entries.get(id);
    if (!entry) throw new ApiError(404, 'ANALYSIS_NOT_FOUND', 'This analysis has expired. Run the analysis again.');
    return entry;
  }
  prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, e] of this.entries) if (e.createdAt < cutoff) this.entries.delete(id);
  }
}

async function view(id, entry, strategyProvider, log) {
  const applied = applyUserProvidedCounts(entry.report, entry.userCounts);
  // Entries are validated before they are stored, so this cannot fail.
  if (!applied.ok) throw new Error('stored user counts no longer apply');
  const report = applied.report;
  // The strategy reflects the current audience (including user-provided counts). A failure
  // here must not hide the research, so it degrades to null.
  let newsletterStrategy = null;
  try {
    newsletterStrategy = await generateNewsletterStrategy(report, { provider: strategyProvider });
  } catch (err) {
    log.error?.(`newsletter strategy failed: ${err.message}`);
  }
  return { analysisId: id, report, newsletterStrategy };
}

function findPlatform(entry, key) {
  const r = entry.report.results.find((x) => x.platformKey === String(key).toLowerCase());
  if (!r) throw new ApiError(404, 'UNKNOWN_PLATFORM', `Unknown platform "${key}".`);
  return r;
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep) || !MIME[extname(file)]) {
    return send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
  }
  try {
    const body = await readFile(file);
    send(res, 200, req.method === 'HEAD' ? '' : body, { 'content-type': MIME[extname(file)], 'cache-control': 'no-cache' });
  } catch {
    send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
  }
}

/**
 * Create the HTTP server. `research` is injectable for tests; it defaults to the
 * engine's researchCompany (which reads BRAVE_SEARCH_API_KEY from the server env).
 */
export function createServer({ research = researchCompany, strategyProvider = deterministicStrategyProvider, store = new AnalysisStore(), log = console } = {}) {
  const render = (id, entry) => view(id, entry, strategyProvider, log);
  async function handleApi(req, res, parts) {
    // POST /api/analyze
    if (parts.length === 1 && parts[0] === 'analyze') {
      if (req.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
      const { website } = await readJson(req);
      const url = normalizeWebsite(website);
      let report;
      try {
        report = await research(url, { useSearch: true });
      } catch (err) {
        log.error?.(`research failed for ${url}: ${err.message}`);
        throw new ApiError(502, 'RESEARCH_FAILED', 'The research could not be completed. Please try again.');
      }
      const id = store.add(report);
      return sendJson(res, 200, await render(id, store.get(id)));
    }
    if (parts[0] !== 'analyses' || !parts[1]) throw new ApiError(404, 'NOT_FOUND', 'Unknown endpoint.');
    const id = parts[1];
    const entry = store.get(id);

    // GET /api/analyses/:id
    if (parts.length === 2) {
      if (req.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET.');
      return sendJson(res, 200, await render(id, entry));
    }

    // PUT|DELETE /api/analyses/:id/user-counts/:platform
    if (parts.length === 4 && parts[2] === 'user-counts') {
      const platform = findPlatform(entry, parts[3]);
      if (req.method === 'PUT') {
        const { count } = await readJson(req);
        // Validate against the automated row, so automated counts can never be overwritten.
        const check = applyUserProvidedCount(platform, count);
        if (!check.ok) throw new ApiError(422, check.code, check.message, { platform: platform.platformKey });
        entry.userCounts = { ...entry.userCounts, [platform.platformKey]: typeof count === 'string' ? count.trim() : count };
        return sendJson(res, 200, await render(id, entry));
      }
      if (req.method === 'DELETE') {
        const { [platform.platformKey]: _removed, ...rest } = entry.userCounts;
        entry.userCounts = rest;
        return sendJson(res, 200, await render(id, entry));
      }
      throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use PUT or DELETE.');
    }
    throw new ApiError(404, 'NOT_FOUND', 'Unknown endpoint.');
  }

  return createHttpServer(async (req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: 'Bad request.' } });
    }
    try {
      if (pathname.startsWith('/api/')) {
        return await handleApi(req, res, pathname.slice(5).split('/').filter(Boolean));
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      return await serveStatic(req, res, pathname);
    } catch (err) {
      if (err instanceof ApiError) return sendJson(res, err.status, { error: { code: err.code, message: err.message, ...err.extra } });
      log.error?.(`unexpected error: ${err.message}`);
      return sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side. Please try again.' } });
    }
  });
}
