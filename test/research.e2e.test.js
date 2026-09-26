// End-to-end pipeline test with a mocked network (synthetic data only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { researchCompany, STATUS } from '../src/research.js';
import { renderText } from '../src/report.js';

const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const ROUTES = {
  'https://www.acme.com/robots.txt': [200, 'User-agent: *\nAllow: /\n'],
  'https://www.acme.com/': [200, fx('company-home.html')],
  'https://www.acme.com': [200, fx('company-home.html')],
  // LinkedIn allows us here -> direct observation.
  'https://www.linkedin.com/robots.txt': [200, 'User-agent: *\nAllow: /company/\n'],
  'https://www.linkedin.com/company/acme/': [200, fx('linkedin-company.html')],
  // Instagram: redirect to login wall -> must NOT be bypassed.
  'https://www.instagram.com/robots.txt': [404, ''],
  'https://www.instagram.com/acme/': [302, '', 'https://www.instagram.com/accounts/login/?next=/acme/'],
  // X: robots disallows everything for generic agents -> not fetched at all.
  'https://x.com/robots.txt': [200, 'User-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /\n'],
  // Facebook: page readable but only exposes likes -> no count.
  'https://www.facebook.com/robots.txt': [200, 'User-agent: *\nAllow: /\n'],
  'https://www.facebook.com/acme': [200, fx('facebook-likes-only.html')],
  // TikTok: embedded JSON.
  'https://www.tiktok.com/robots.txt': [200, 'User-agent: *\nAllow: /\n'],
  'https://www.tiktok.com/@acmehq': [200, fx('tiktok-profile.html')],
};

const requested = [];
globalThis.fetch = async (url) => {
  requested.push(String(url));
  const r = ROUTES[String(url)];
  if (!r) throw new Error(`unexpected fetch ${url}`);
  const [status, body, location] = r;
  return new Response(body, { status, headers: location ? { location } : {} });
};

test('pipeline returns sourced counts and honest unavailability', async () => {
  const report = await researchCompany('https://www.acme.com', { useSearch: false });
  const by = Object.fromEntries(report.results.map((r) => [r.platform, r]));

  assert.equal(by.LinkedIn.status, STATUS.VERIFIED_COUNT);
  assert.equal(by.LinkedIn.followerCount, 12345);
  assert.equal(by.LinkedIn.confidence, 'HIGH');
  assert.equal(by.LinkedIn.sourceUrl, 'https://www.linkedin.com/company/acme/');

  assert.equal(by.Instagram.status, STATUS.PROFILE_FOUND_COUNT_UNAVAILABLE);
  assert.equal(by.Instagram.followerCount, null);
  assert.match(by.Instagram.attempts[0].outcome, /login/);
  assert.ok(!requested.some((u) => u.includes('/accounts/login')), 'must not follow into the login wall');

  assert.equal(by.X.status, STATUS.PROFILE_FOUND_COUNT_UNAVAILABLE);
  assert.match(by.X.attempts[0].outcome, /robots\.txt/);
  assert.ok(!requested.includes('https://x.com/acme'), 'robots-disallowed page must not be fetched');

  assert.equal(by.Facebook.status, STATUS.PROFILE_FOUND_COUNT_UNAVAILABLE);
  assert.equal(by.Facebook.followerCount, null);

  assert.equal(by.TikTok.followerCount, 3579);

  for (const r of report.results) {
    if (r.followerCount !== null) assert.ok(r.sourceUrl && r.evidence && r.status === STATUS.VERIFIED_COUNT);
    else assert.equal(r.confidence, 'NOT_AVAILABLE');
  }

  const text = renderText(report);
  assert.match(text, /Combined Verified Social Following: 15,924/);
  assert.match(text, /NOT a count of unique people/);
});

test('no profiles -> PROFILE_NOT_FOUND everywhere and no combined total', async () => {
  ROUTES['https://empty.example/robots.txt'] = [200, ''];
  ROUTES['https://empty.example'] = [200, '<html><body>no socials</body></html>'];
  const report = await researchCompany('https://empty.example', { useSearch: false });
  assert.ok(report.results.every((r) => r.status === STATUS.PROFILE_NOT_FOUND && r.followerCount === null && !r.profileFound));
  assert.match(renderText(report), /no combined total/);
});
