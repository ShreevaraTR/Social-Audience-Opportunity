// Vercel adaptation: the serverless entry point, stateless analysis tokens (consecutive
// requests may reach different instances) and the deployment config. Offline only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { createServer, AnalysisStore, signAnalysis, verifyAnalysisToken } from '../src/server.js';
import { buildResult, SOURCE_TYPE, PRECISION } from '../src/research.js';
import { summarizeAudience } from '../src/audience.js';
import { PLATFORMS } from '../src/platforms.js';

const SENTINEL_KEY = 'sk-test-SENTINEL-vercel-credential-51c2';
process.env.BRAVE_SEARCH_API_KEY = SENTINEL_KEY;
delete process.env.ANALYSIS_TOKEN_SECRET;

const platform = (key) => PLATFORMS.find((p) => p.key === key);
const profile = (url) => ({ url, discoveredVia: 'company website (anchor)', official: true });

// A small automated report, so no network is needed.
async function fakeResearch(url) {
  const results = [
    buildResult({ platform: platform('linkedin'), profile: profile('https://www.linkedin.com/company/acme/') }),
    buildResult({
      platform: platform('tiktok'),
      profile: profile('https://www.tiktok.com/@acme'),
      finding: { value: 10963, display: '10963', precision: PRECISION.EXACT, sourceType: SOURCE_TYPE.AUTO_VERIFIED, sourceUrl: 'https://www.tiktok.com/@acme', evidence: 'statsV2' },
    }),
  ];
  return {
    companyUrl: url,
    generatedAt: new Date().toISOString(),
    discoveryNotes: [],
    site: { url, finalUrl: url, reachable: true, name: 'Acme', description: 'The newsletter platform for teams.', headings: [], navLabels: [] },
    results,
    audience: summarizeAudience(results),
  };
}

const servers = [];
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
after(() => servers.forEach((s) => s.close()));

async function call(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  assert.ok(!text.includes(SENTINEL_KEY), 'credential leaked');
  return { status: res.status, json: JSON.parse(text), text };
}

// Two independent instances (separate memory), like two serverless invocations.
let A;
let B;
before(async () => {
  A = await listen(createServer({ research: fakeResearch, log: {} }));
  B = await listen(createServer({ research: fakeResearch, log: {} }));
});

test('an analysis started on one instance can be continued on another via its token', async () => {
  const start = await call(A, 'POST', '/api/analyze', { website: 'https://acme.example/' });
  assert.equal(start.status, 200);
  const { analysisId, analysisToken } = start.json;
  assert.ok(analysisToken);

  // Without the token, instance B has never seen this analysis.
  assert.equal((await call(B, 'PUT', `/api/analyses/${analysisId}/user-counts/linkedin`, { count: '71,000' })).json.error.code, 'ANALYSIS_NOT_FOUND');

  const put = await call(B, 'PUT', `/api/analyses/${analysisId}/user-counts/linkedin`, { count: '71,000', analysisToken });
  assert.equal(put.status, 200);
  const li = put.json.report.results.find((r) => r.platformKey === 'linkedin');
  assert.equal(li.status, 'USER_PROVIDED_COUNT');
  assert.equal(li.sourceType, 'USER_PROVIDED');
  assert.equal(put.json.report.audience.totalAudienceFootprint.total, 81963);
  assert.equal(put.json.newsletterStrategy.contentThemes.length, 3);

  // Back on A (whose memory has no user counts), the newer token wins.
  const del = await call(A, 'DELETE', `/api/analyses/${analysisId}/user-counts/linkedin`, { analysisToken: put.json.analysisToken });
  assert.equal(del.status, 200);
  assert.equal(del.json.report.audience.totalAudienceFootprint.total, 10963);
  const again = await call(B, 'PUT', `/api/analyses/${analysisId}/user-counts/linkedin`, { count: '70,000', analysisToken: del.json.analysisToken });
  assert.equal(again.json.report.audience.userProvided.total, 70000);

  // Validation still happens on the server: automated counts can't be overwritten.
  const bad = await call(B, 'PUT', `/api/analyses/${analysisId}/user-counts/tiktok`, { count: '1', analysisToken });
  assert.equal(bad.json.error.code, 'NOT_ELIGIBLE');
});

test('tampered, mismatched or expired tokens are rejected', async () => {
  const start = await call(A, 'POST', '/api/analyze', { website: 'https://acme.example/' });
  const { analysisId, analysisToken } = start.json;
  const [payload, sig] = analysisToken.split('.');

  // Forge a "verified" LinkedIn count inside the token.
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  const li = data.report.results.find((r) => r.platformKey === 'linkedin');
  Object.assign(li, { status: 'VERIFIED_COUNT', followerCount: 999999, sourceType: 'AUTO_VERIFIED', confidence: 'HIGH' });
  const forged = `${Buffer.from(JSON.stringify(data)).toString('base64url')}.${sig}`;
  for (const token of [forged, `${payload}.${sig}x`, 'not-a-token', `${payload}.${sig}.extra`]) {
    const res = await call(B, 'PUT', `/api/analyses/${analysisId}/user-counts/x`, { count: '5', analysisToken: token });
    assert.equal(res.status, 404, token.slice(0, 20));
    assert.equal(res.json.error.code, 'ANALYSIS_NOT_FOUND');
  }
  // Token for a different analysis id.
  assert.equal((await call(B, 'PUT', '/api/analyses/other-id/user-counts/linkedin', { count: '5', analysisToken })).status, 404);

  const entry = { report: await fakeResearch('https://acme.example/'), userCounts: {}, createdAt: Date.now() - 3 * 60 * 60 * 1000 };
  assert.equal(verifyAnalysisToken(signAnalysis('id-1', entry), 'id-1'), null, 'expired');
  const fresh = { ...entry, createdAt: Date.now() };
  assert.deepEqual(verifyAnalysisToken(signAnalysis('id-1', fresh), 'id-1').userCounts, {});

  // A deployment with a different secret cannot use the token.
  const token = signAnalysis('id-1', fresh);
  process.env.ANALYSIS_TOKEN_SECRET = 'another-deployment';
  try {
    assert.equal(verifyAnalysisToken(token, 'id-1'), null);
  } finally {
    delete process.env.ANALYSIS_TOKEN_SECRET;
  }
});

test('the token is signed state only: no credential inside', async () => {
  const start = await call(A, 'POST', '/api/analyze', { website: 'https://acme.example/' });
  const decoded = Buffer.from(start.json.analysisToken.split('.')[0], 'base64url').toString();
  assert.ok(!decoded.includes(SENTINEL_KEY));
  assert.deepEqual(Object.keys(JSON.parse(decoded)).sort(), ['createdAt', 'id', 'report', 'userCounts', 'v']);
});

test('AnalysisStore.set keeps the size bound', () => {
  const store = new AnalysisStore({ max: 2 });
  store.set('a', { createdAt: Date.now() });
  store.set('b', { createdAt: Date.now() });
  store.set('c', { createdAt: Date.now() });
  assert.deepEqual([...store.entries.keys()], ['b', 'c']);
});

test('Vercel entry point routes both original and rewritten URLs to the shared app', async () => {
  const { default: handler } = await import('../api/index.js');
  const base = await listen(createHttpServer(handler));
  // Original URL form.
  let res = await call(base, 'POST', '/api/analyze', { website: 'not a url' });
  assert.equal(res.json.error.code, 'INVALID_URL');
  // Rewritten form: /api/index?__path=...
  res = await call(base, 'POST', '/api/index?__path=analyze', { website: 'not a url' });
  assert.equal(res.json.error.code, 'INVALID_URL');
  res = await call(base, 'GET', `/api/index?__path=${encodeURIComponent('analyses/missing-id')}`);
  assert.equal(res.json.error.code, 'ANALYSIS_NOT_FOUND');
  // Original URL with the rewrite's query merged in.
  res = await call(base, 'GET', '/api/analyses/missing-id?__path=analyses/missing-id');
  assert.equal(res.json.error.code, 'ANALYSIS_NOT_FOUND');
  res = await call(base, 'PUT', '/api/index?__path=analyses/missing-id/user-counts/linkedin', { count: '1' });
  assert.equal(res.status, 404);
});

test('vercel.json serves public/ statically and sends /api/* to the function', () => {
  const cfg = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal(cfg.outputDirectory, 'public');
  assert.ok(existsSync(new URL('../public/index.html', import.meta.url)));
  assert.ok(existsSync(new URL('../api/index.js', import.meta.url)));
  assert.deepEqual(cfg.rewrites, [{ source: '/api/:path*', destination: '/api/index?__path=:path*' }]);
  assert.ok(cfg.functions['api/index.js'].maxDuration >= 30);
  const csp = cfg.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(JSON.stringify(cfg), /BRAVE|subscription/i);
});
