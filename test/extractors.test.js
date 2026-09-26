import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseFollowerNumber,
  extractLinkedIn,
  extractInstagram,
  extractFacebook,
  extractTikTok,
  extractX,
} from '../src/extractors.js';
import { extractLinks, pickProfiles } from '../src/discover.js';
import { parseRobots, isAllowedByRobots, detectAccessRestriction } from '../src/http.js';

const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('parseFollowerNumber: exact and source-rounded values, rejects junk', () => {
  assert.deepEqual(parseFollowerNumber('12,345'), { value: 12345, display: '12,345', precision: 'EXACT' });
  assert.deepEqual(parseFollowerNumber('71K'), { value: 71000, display: '71K', precision: 'ROUNDED_BY_SOURCE' });
  assert.equal(parseFollowerNumber('1.5M').value, 1500000);
  assert.equal(parseFollowerNumber('12,34'), null);
  assert.equal(parseFollowerNumber('abc'), null);
  assert.equal(parseFollowerNumber(''), null);
});

test('discovery: picks company profiles, skips share/intent/personal links, prefers brand handle', () => {
  const links = extractLinks(fx('company-home.html'), 'https://www.acme.com/');
  const p = pickProfiles(links, 'https://www.acme.com');
  assert.equal(p.linkedin.url, 'https://www.linkedin.com/company/acme/');
  assert.equal(p.instagram.url, 'https://www.instagram.com/acme/');
  assert.equal(p.x.url, 'https://x.com/acme');
  assert.deepEqual(p.x.alternatives, ['https://x.com/acme_support']);
  assert.equal(p.facebook.url, 'https://www.facebook.com/acme');
  assert.equal(p.tiktok.url, 'https://www.tiktok.com/@acmehq');
  assert.match(p.tiktok.discoveredVia, /json-ld sameAs/);
  assert.ok(Object.values(p).every((x) => x.official));
});

test('LinkedIn: exact count from meta description', () => {
  const r = extractLinkedIn(fx('linkedin-company.html'));
  assert.equal(r.value, 12345);
  assert.equal(r.precision, 'EXACT');
  assert.match(r.evidence, /12,345 followers on LinkedIn/);
});

test('LinkedIn: rounded display is kept as-is and flagged, not "completed"', () => {
  const r = extractLinkedIn(fx('linkedin-rounded.html'));
  assert.equal(r.display, '71K');
  assert.equal(r.precision, 'ROUNDED_BY_SOURCE');
});

test('Instagram: followers taken from og:description, not following/posts', () => {
  const r = extractInstagram(fx('instagram-profile.html'));
  assert.equal(r.value, 2468);
});

test('Facebook: likes are NEVER treated as followers', () => {
  assert.equal(extractFacebook(fx('facebook-likes-only.html')), null);
  assert.equal(extractFacebook(fx('facebook-followers.html')).value, 11111);
});

test('TikTok: uses stats.followerCount for the matching handle only, never hearts', () => {
  assert.equal(extractTikTok(fx('tiktok-profile.html'), 'acmehq').value, 3579);
  assert.equal(extractTikTok(fx('tiktok-other-user.html'), 'acmehq'), null);
});

test('X: JS-only shell yields no count (no guessing)', () => {
  assert.equal(extractX(fx('x-profile-shell.html'), 'acme'), null);
});

test('robots.txt: disallow-all for generic bots is honoured; allow-listed bots are not us', () => {
  const groups = parseRobots('User-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /\n');
  assert.equal(isAllowedByRobots(groups, '/company/acme').allowed, false);
  const open = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok$\n');
  assert.equal(isAllowedByRobots(open, '/company/acme').allowed, true);
  assert.equal(isAllowedByRobots(open, '/private/x').allowed, false);
  assert.equal(isAllowedByRobots(open, '/private/ok').allowed, true);
});

test('access restrictions: login redirects, 999, 429 and CAPTCHA pages are detected', () => {
  assert.match(detectAccessRestriction({ status: 200, finalUrl: 'https://www.linkedin.com/authwall?x=1', html: '' }), /login/);
  assert.match(detectAccessRestriction({ status: 200, finalUrl: 'https://www.instagram.com/accounts/login/', html: '' }), /login/);
  assert.match(detectAccessRestriction({ status: 999, finalUrl: 'https://www.linkedin.com/company/a', html: '' }), /999/);
  assert.match(detectAccessRestriction({ status: 429, finalUrl: 'https://x.com/a', html: '' }), /429/);
  assert.match(detectAccessRestriction({ status: 200, finalUrl: 'https://a.com', html: '<p>Please complete the CAPTCHA</p>' }), /CAPTCHA/);
  assert.equal(detectAccessRestriction({ status: 200, finalUrl: 'https://a.com', html: '<p>hi</p>' }), null);
});
