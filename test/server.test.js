// Web/API layer. The real research engine runs against a mocked network shaped like the
// Beehiiv run of 2026-09-26 (synthetic pages, stubbed Brave responses - no live calls).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, normalizeWebsite } from '../src/server.js';

const SENTINEL_KEY = 'sk-test-SENTINEL-brave-credential-7f3a91';
process.env.BRAVE_SEARCH_API_KEY = SENTINEL_KEY;

const BRAVE = 'https://api.search.brave.com/res/v1/web/search';
const TIKTOK_PAGE =
  '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">' +
  '{"__DEFAULT_SCOPE__":{"webapp.user-detail":{"userInfo":{"user":{"uniqueId":"beehiiv"},"stats":{"followerCount":11000},"statsV2":{"followerCount":"10963"}}}}}</script>';
const HOME =
  '<html><head><title>beehiiv — The newsletter platform built for growth</title>' +
  '<meta property="og:site_name" content="beehiiv">' +
  '<meta name="description" content="The newsletter platform built for growth.">' +
  '<script type="application/ld+json">{"sameAs":["https://www.linkedin.com/company/beehiiv","https://www.instagram.com/beehiiv/","https://x.com/beehiiv","https://www.tiktok.com/@beehiiv"]}</script>' +
  '</head><body><a href="https://www.facebook.com/trybeehiiv">Facebook</a></body></html>';
const DISALLOW_ALL = 'User-agent: *\nDisallow: /\n';
const ROUTES = {
  'https://www.beehiiv.com/robots.txt': [200, 'User-agent: *\nAllow: /\n'],
  'https://www.beehiiv.com/': [200, HOME],
  'https://www.linkedin.com/robots.txt': [200, DISALLOW_ALL],
  'https://www.instagram.com/robots.txt': [200, DISALLOW_ALL],
  'https://x.com/robots.txt': [200, DISALLOW_ALL],
  'https://www.facebook.com/robots.txt': [200, DISALLOW_ALL],
  'https://www.tiktok.com/robots.txt': [200, ''],
  'https://www.tiktok.com/@beehiiv': [200, TIKTOK_PAGE],
  'https://down.example/robots.txt': [503, ''],
};
const SNIPPETS = {
  'https://www.instagram.com/beehiiv/': { title: 'beehiiv • Instagram photos and videos', description: '22K followers, 318 following, 678 posts' },
  'https://www.facebook.com/trybeehiiv': { title: 'beehiiv | Facebook', url: 'https://www.facebook.com/trybeehiiv/', description: 'beehiiv, New York. 5,079 followers · 234 talking about this.' },
};

const realFetch = globalThis.fetch;
const braveHeaders = [];
let server;
let base;

before(async () => {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
    if (u.startsWith(BRAVE)) {
      braveHeaders.push(opts.headers || {});
      const q = new URL(u).searchParams.get('q');
      const s = SNIPPETS[q];
      return new Response(JSON.stringify({ web: { results: s ? [{ url: s.url || q, title: s.title, description: s.description }] : [] } }), { status: 200 });
    }
    const r = ROUTES[u];
    if (!r) throw new Error(`unexpected fetch ${u}`);
    return new Response(r[1], { status: r[0] });
  };
  server = createServer({ log: {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  globalThis.fetch = realFetch;
});

const responses = [];
async function call(method, path, body, headers = {}) {
  const res = await realFetch(base + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  responses.push({ text, headers: JSON.stringify([...res.headers]) });
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* static file */
  }
  return { status: res.status, json, text, headers: res.headers };
}
const by = (report) => Object.fromEntries(report.results.map((r) => [r.platformKey, r]));

let analysisId;

test('POST /api/analyze returns the Beehiiv research through the real engine', async () => {
  const { status, json } = await call('POST', '/api/analyze', { website: 'https://www.beehiiv.com/' });
  assert.equal(status, 200);
  analysisId = json.analysisId;
  assert.match(analysisId, /^[0-9a-f-]{36}$/);
  const r = by(json.report);

  assert.equal(json.report.site.name, 'beehiiv');
  assert.equal(json.report.site.reachable, true);

  assert.equal(r.instagram.status, 'VERIFIED_COUNT');
  assert.equal(r.instagram.sourceType, 'SEARCH_DERIVED');
  assert.equal(r.instagram.followerCountDisplay, '22K');
  assert.equal(r.instagram.followerCountPrecision, 'ROUNDED_BY_SOURCE');
  assert.equal(r.facebook.followerCount, 5079);
  assert.equal(r.facebook.sourceType, 'SEARCH_DERIVED');
  assert.equal(r.tiktok.followerCount, 10963);
  assert.equal(r.tiktok.sourceType, 'AUTO_VERIFIED');
  assert.equal(r.tiktok.confidence, 'HIGH');
  for (const k of ['linkedin', 'x']) {
    assert.equal(r[k].status, 'PROFILE_FOUND_COUNT_UNAVAILABLE');
    assert.equal(r[k].needsUserInput, true);
  }
  assert.equal(json.report.audience.publiclySourced.total, 38042);
  assert.deepEqual(json.report.audience.needsUserInput, ['LinkedIn', 'X']);
  assert.equal(json.newsletter.companyName, 'beehiiv');
  assert.equal(json.newsletter.contentThemes.status, 'NOT_GENERATED');

  // The credential was used server-side for Brave...
  assert.ok(braveHeaders.length > 0);
  assert.ok(braveHeaders.every((h) => h['x-subscription-token'] === SENTINEL_KEY));
});

test('user-provided LinkedIn/X counts update the summary and planning scenarios', async () => {
  const before = (await call('GET', `/api/analyses/${analysisId}`)).json.report.audience;
  assert.deepEqual(before.planningScenarios.scenarios.map((s) => s.audienceAtPercent), [380, 1141, 1902]);

  let res = await call('PUT', `/api/analyses/${analysisId}/user-counts/linkedin`, { count: '71,000' });
  assert.equal(res.status, 200);
  res = await call('PUT', `/api/analyses/${analysisId}/user-counts/x`, { count: 12000 });
  assert.equal(res.status, 200);

  const { audience } = res.json.report;
  assert.equal(audience.publiclySourced.total, 38042);
  assert.equal(audience.publiclySourced.bySourceType.AUTO_VERIFIED.total, 10963);
  assert.equal(audience.publiclySourced.bySourceType.SEARCH_DERIVED.total, 27079);
  assert.equal(audience.userProvided.total, 83000);
  assert.equal(audience.totalAudienceFootprint.total, 121042);
  assert.equal(audience.totalAudienceFootprint.platformCount, 5);
  assert.equal(audience.totalAudienceFootprint.includesRoundedValues, true);
  assert.deepEqual(audience.needsUserInput, []);
  assert.deepEqual(audience.planningScenarios.scenarios.map((s) => s.audienceAtPercent), [1210, 3631, 6052]);
  assert.equal(audience.planningScenarios.baseAudience, 121042);

  // State persists server-side.
  const again = (await call('GET', `/api/analyses/${analysisId}`)).json.report.audience;
  assert.equal(again.totalAudienceFootprint.total, 121042);
});

test('user-provided counts stay USER_PROVIDED_COUNT and are never represented as verified', async () => {
  const { json } = await call('GET', `/api/analyses/${analysisId}`);
  const r = by(json.report);
  for (const k of ['linkedin', 'x']) {
    assert.equal(r[k].status, 'USER_PROVIDED_COUNT');
    assert.equal(r[k].sourceType, 'USER_PROVIDED');
    assert.equal(r[k].confidence, 'UNVERIFIED');
    assert.notEqual(r[k].status, 'VERIFIED_COUNT');
    assert.ok(!['AUTO_VERIFIED', 'SEARCH_DERIVED'].includes(r[k].sourceType));
    assert.ok(!['HIGH', 'MEDIUM', 'LOW'].includes(r[k].confidence));
  }
  assert.equal(r.linkedin.followerCount, 71000);
  assert.equal(r.x.followerCount, 12000);
  assert.ok(!json.report.audience.publiclySourced.platforms.includes('LinkedIn'));
  assert.doesNotMatch(json.report.audience.totalAudienceFootprint.label, /verified/i);
  const channel = json.newsletter.acquisitionChannels.items.find((c) => c.platformKey === 'linkedin');
  assert.equal(channel.sourceType, 'USER_PROVIDED');
});

test('invalid or ineligible user input is rejected by the server and changes nothing', async () => {
  let res = await call('PUT', `/api/analyses/${analysisId}/user-counts/x`, { count: '12K' });
  assert.equal(res.status, 422);
  assert.equal(res.json.error.code, 'SHORTHAND_NOT_SUPPORTED');
  res = await call('PUT', `/api/analyses/${analysisId}/user-counts/x`, { count: '-4' });
  assert.equal(res.json.error.code, 'NOT_POSITIVE');
  res = await call('PUT', `/api/analyses/${analysisId}/user-counts/tiktok`, { count: '99999' });
  assert.equal(res.status, 422);
  assert.equal(res.json.error.code, 'NOT_ELIGIBLE');
  res = await call('PUT', `/api/analyses/${analysisId}/user-counts/instagram`, { count: '22000' });
  assert.equal(res.json.error.code, 'NOT_ELIGIBLE');
  res = await call('PUT', `/api/analyses/${analysisId}/user-counts/myspace`, { count: '1' });
  assert.equal(res.status, 404);

  const { json } = await call('GET', `/api/analyses/${analysisId}`);
  assert.equal(by(json.report).x.followerCount, 12000);
  assert.equal(by(json.report).tiktok.followerCount, 10963);
  assert.equal(json.report.audience.totalAudienceFootprint.total, 121042);
});

test('editing and removing a user-provided count recomputes from the automated result', async () => {
  let res = await call('PUT', `/api/analyses/${analysisId}/user-counts/x`, { count: '13,000' });
  assert.equal(res.json.report.audience.userProvided.total, 84000);
  res = await call('DELETE', `/api/analyses/${analysisId}/user-counts/x`);
  assert.equal(res.status, 200);
  const x = by(res.json.report).x;
  assert.equal(x.status, 'PROFILE_FOUND_COUNT_UNAVAILABLE');
  assert.equal(x.followerCount, null);
  assert.equal(x.sourceType, null);
  assert.equal(x.needsUserInput, true);
  assert.equal(res.json.report.audience.totalAudienceFootprint.total, 38042 + 71000);
  res = await call('PUT', `/api/analyses/${analysisId}/user-counts/x`, { count: '12,000' });
  assert.equal(res.json.report.audience.totalAudienceFootprint.total, 121042);
});

test('request errors: invalid URL, unknown analysis, wrong content type, bad JSON', async () => {
  for (const website of ['', 'not a url', 'ftp://example.com', 'http://localhost:3000', 'http://127.0.0.1/', 'https://user:pw@example.com']) {
    const res = await call('POST', '/api/analyze', { website });
    assert.equal(res.status, 400, website);
    assert.equal(res.json.error.code, 'INVALID_URL');
  }
  assert.equal((await call('GET', '/api/analyses/does-not-exist')).json.error.code, 'ANALYSIS_NOT_FOUND');
  assert.equal((await call('POST', '/api/analyze', 'website=x', { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await call('POST', '/api/analyze', '{nope')).json.error.code, 'INVALID_JSON');
  assert.equal((await call('GET', '/api/analyze')).status, 405);
});

test('website unreachable still returns a structured (partial) report', async () => {
  const { status, json } = await call('POST', '/api/analyze', { website: 'down.example' });
  assert.equal(status, 200);
  assert.equal(json.report.site.reachable, false);
  assert.match(json.report.site.blockedReason, /robots\.txt returned 503/);
  assert.ok(json.report.results.every((r) => r.status === 'PROFILE_NOT_FOUND'));
  assert.equal(json.report.audience.planningScenarios, null);
});

test('research failure is reported as RESEARCH_FAILED, not a blank response', async () => {
  const failing = createServer({ research: async () => { throw new Error(`boom ${SENTINEL_KEY}`); }, log: {} });
  await new Promise((resolve) => failing.listen(0, '127.0.0.1', resolve));
  const res = await realFetch(`http://127.0.0.1:${failing.address().port}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ website: 'https://www.beehiiv.com/' }),
  });
  const text = await res.text();
  responses.push({ text, headers: '' });
  failing.close();
  assert.equal(res.status, 502);
  assert.equal(JSON.parse(text).error.code, 'RESEARCH_FAILED');
});

test('static UI is served with a strict CSP', async () => {
  const page = await call('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /Beehiiv Audience Opportunity/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await call('GET', '/app.js')).status, 200);
  assert.equal((await call('GET', '/styles.css')).status, 200);
  assert.equal((await call('GET', '/../src/search.js')).status, 404);
  assert.equal((await call('GET', '/%2e%2e/src/search.js')).status, 404);
});

test('Brave credentials never appear in any API response, header or static file', () => {
  assert.ok(responses.length > 20);
  for (const { text, headers } of responses) {
    assert.ok(!text.includes(SENTINEL_KEY), 'credential value leaked in body');
    assert.ok(!headers.includes(SENTINEL_KEY), 'credential value leaked in headers');
    assert.doesNotMatch(text, /x-subscription-token|BRAVE_SEARCH_API_KEY/i);
  }
});

test('normalizeWebsite adds https:// and keeps the path', () => {
  assert.equal(normalizeWebsite('beehiiv.com'), 'https://beehiiv.com/');
  assert.equal(normalizeWebsite(' https://www.beehiiv.com/ '), 'https://www.beehiiv.com/');
  assert.equal(normalizeWebsite('http://example.com/about#team'), 'http://example.com/about');
});

test('company name comes from what the homepage states, preferring the brand segment of <title>', async () => {
  const { extractCompanyInfo } = await import('../src/company.js');
  assert.equal(extractCompanyInfo('<script type="application/ld+json">{"@type":"Organization","name":"beehiiv"}</script><title>Newsletter Platform - beehiiv</title>', 'https://www.beehiiv.com/').name, 'beehiiv');
  assert.equal(extractCompanyInfo('<title>Newsletter Platform: Create Newsletters - beehiiv</title>', 'https://www.beehiiv.com/').name, 'beehiiv');
  assert.equal(extractCompanyInfo('<meta property="og:site_name" content="Acme Co"><title>x</title>', 'https://acme.com').name, 'Acme Co');
  assert.equal(extractCompanyInfo('<title>Acme | Rockets</title>', 'https://acme.com').name, 'Acme');
  const bare = extractCompanyInfo('', 'https://www.acme.com/');
  assert.deepEqual([bare.name, bare.nameSource, bare.description], ['acme.com', 'website hostname', null]);
});
