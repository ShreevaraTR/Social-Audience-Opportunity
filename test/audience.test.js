// Human-in-the-loop fallback, provenance and audience totals. Offline only: results are
// built with the engine's own buildResult(), and the pipeline test mocks the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResult, researchCompany, STATUS, SOURCE_TYPE, CONFIDENCE, PRECISION } from '../src/research.js';
import {
  validateUserFollowerCount,
  applyUserProvidedCount,
  applyUserProvidedCounts,
  summarizeAudience,
  planningScenarios,
  MAX_USER_FOLLOWER_COUNT,
} from '../src/audience.js';
import { parseFollowerNumber } from '../src/extractors.js';
import { PLATFORMS } from '../src/platforms.js';
import { renderText } from '../src/report.js';

const platform = (key) => PLATFORMS.find((p) => p.key === key);
const profile = (url) => ({ url, handle: 'beehiiv', discoveredVia: 'company website (anchor)', official: true });

// The Beehiiv run of 2026-09-26, reduced to what the engine produced.
function beehiivReport() {
  const results = [
    buildResult({ platform: platform('linkedin'), profile: profile('https://www.linkedin.com/company/beehiiv/') }),
    buildResult({
      platform: platform('instagram'),
      profile: profile('https://www.instagram.com/beehiiv/'),
      finding: {
        ...parseFollowerNumber('22K'),
        sourceType: SOURCE_TYPE.SEARCH_DERIVED,
        sourceUrl: 'https://www.instagram.com/beehiiv/',
        evidence: 'Search-engine snippet: "22K followers"',
      },
    }),
    buildResult({ platform: platform('x'), profile: profile('https://x.com/beehiiv') }),
    buildResult({
      platform: platform('facebook'),
      profile: profile('https://www.facebook.com/trybeehiiv'),
      finding: {
        ...parseFollowerNumber('5,079'),
        sourceType: SOURCE_TYPE.SEARCH_DERIVED,
        sourceUrl: 'https://www.facebook.com/trybeehiiv/',
        evidence: 'Search-engine snippet: "5,079 followers"',
      },
    }),
    buildResult({
      platform: platform('tiktok'),
      profile: profile('https://www.tiktok.com/@beehiiv'),
      finding: {
        value: 10963,
        display: '10963',
        precision: PRECISION.EXACT,
        sourceType: SOURCE_TYPE.AUTO_VERIFIED,
        sourceUrl: 'https://www.tiktok.com/@beehiiv',
        evidence: 'statsV2.followerCount "10963"',
      },
    }),
  ];
  return { companyUrl: 'https://www.beehiiv.com/', generatedAt: '2026-09-26T00:00:00.000Z', discoveryNotes: [], results, audience: summarizeAudience(results) };
}
const by = (report) => Object.fromEntries(report.results.map((r) => [r.platformKey, r]));

test('Beehiiv: automated provenance and the platforms awaiting user input', () => {
  const report = beehiivReport();
  const r = by(report);
  assert.equal(r.tiktok.sourceType, SOURCE_TYPE.AUTO_VERIFIED);
  assert.equal(r.tiktok.confidence, CONFIDENCE.HIGH);
  assert.equal(r.facebook.sourceType, SOURCE_TYPE.SEARCH_DERIVED);
  assert.equal(r.facebook.confidence, CONFIDENCE.MEDIUM);
  for (const k of ['linkedin', 'x']) {
    assert.equal(r[k].status, STATUS.PROFILE_FOUND_COUNT_UNAVAILABLE);
    assert.equal(r[k].followerCount, null);
    assert.equal(r[k].sourceType, null);
    assert.equal(r[k].needsUserInput, true);
  }
  assert.deepEqual(report.audience.needsUserInput, ['LinkedIn', 'X']);
  assert.equal(report.audience.publiclySourced.total, 38042);
  assert.equal(report.audience.totalAudienceFootprint.total, 38042);
  assert.equal(report.audience.totalAudienceFootprint.includesUserProvided, false);
});

test('rounded search-derived count keeps "22K" and is flagged as rounded', () => {
  const ig = by(beehiivReport()).instagram;
  assert.equal(ig.followerCountDisplay, '22K');
  assert.equal(ig.followerCount, 22000);
  assert.equal(ig.followerCountPrecision, PRECISION.ROUNDED_BY_SOURCE);
  assert.equal(ig.sourceType, SOURCE_TYPE.SEARCH_DERIVED);
  const { publiclySourced, totalAudienceFootprint } = beehiivReport().audience;
  assert.equal(publiclySourced.includesRoundedValues, true);
  assert.equal(totalAudienceFootprint.includesRoundedValues, true);
});

test('Beehiiv + user-provided LinkedIn 71,000 and X 12,000 -> 38,042 + 83,000 = 121,042', () => {
  const applied = applyUserProvidedCounts(beehiivReport(), { linkedin: '71,000', X: 12000 });
  assert.equal(applied.ok, true);
  const { audience } = applied.report;

  assert.equal(audience.publiclySourced.total, 22000 + 5079 + 10963);
  assert.equal(audience.publiclySourced.total, 38042);
  assert.equal(audience.publiclySourced.platformCount, 3);
  assert.deepEqual(audience.publiclySourced.platforms, ['Instagram', 'Facebook', 'TikTok']);
  assert.equal(audience.publiclySourced.bySourceType.AUTO_VERIFIED.total, 10963);
  assert.equal(audience.publiclySourced.bySourceType.SEARCH_DERIVED.total, 27079);

  assert.equal(audience.userProvided.total, 83000);
  assert.equal(audience.userProvided.platformCount, 2);
  assert.deepEqual(audience.userProvided.platforms, ['LinkedIn', 'X']);

  assert.equal(audience.totalAudienceFootprint.total, 121042);
  assert.equal(audience.totalAudienceFootprint.total, audience.publiclySourced.total + audience.userProvided.total);
  assert.equal(audience.totalAudienceFootprint.platformCount, 5);
  assert.equal(audience.totalAudienceFootprint.includesUserProvided, true);
  assert.equal(audience.totalAudienceFootprint.label, 'Total Social Audience');
  assert.doesNotMatch(audience.totalAudienceFootprint.label, /verified/i);
  assert.deepEqual(audience.needsUserInput, []);

  // 1% of 121,042 = 1,210.42; 3% = 3,631.26; 5% = 6,052.1 -> half-up to whole numbers.
  assert.equal(audience.planningScenarios.baseAudience, 121042);
  assert.deepEqual(
    audience.planningScenarios.scenarios.map((s) => [s.percent, s.audienceAtPercent]),
    [[1, 1210], [3, 3631], [5, 6052]],
  );
  assert.match(audience.planningScenarios.label, /not predictions/);
});

test('user-provided counts are labelled USER_PROVIDED and never verified', () => {
  const report = applyUserProvidedCounts(beehiivReport(), { linkedin: '71,000', x: '12000' }).report;
  const r = by(report);
  for (const k of ['linkedin', 'x']) {
    assert.equal(r[k].status, STATUS.USER_PROVIDED_COUNT);
    assert.notEqual(r[k].status, STATUS.VERIFIED_COUNT);
    assert.equal(r[k].sourceType, SOURCE_TYPE.USER_PROVIDED);
    assert.equal(r[k].confidence, CONFIDENCE.UNVERIFIED);
    assert.equal(r[k].followerCountPrecision, PRECISION.AS_PROVIDED_BY_USER);
    assert.equal(r[k].sourceUrl, null);
    assert.equal(r[k].needsUserInput, false);
    assert.ok(r[k].userProvidedAt);
    assert.match(r[k].evidence, /entered by the user/);
  }
  assert.equal(r.linkedin.followerCount, 71000);
  assert.equal(r.linkedin.followerCountDisplay, '71,000');
  // Automated rows are untouched.
  assert.equal(r.tiktok.sourceType, SOURCE_TYPE.AUTO_VERIFIED);
  assert.equal(r.instagram.sourceType, SOURCE_TYPE.SEARCH_DERIVED);

  const text = renderText(report);
  assert.match(text, /LinkedIn: Not verified; 71,000 \(user-provided; not verified\)/);
  assert.match(text, /Combined Verified Social Following: 38,042/);
  assert.match(text, /Total Social Audience: 121,042 \(includes publicly sourced and user-provided/);
  assert.match(text, /User provided: +83,000 across 2 platform\(s\): LinkedIn, X/);
  assert.match(text, /Planning scenarios — not predictions/);
  assert.match(text, /3% = 3,631/);
  assert.doesNotMatch(text, /expected|predicted|likely|forecast/i);
});

test('user input is accepted as a positive whole number, commas normalised only', () => {
  assert.deepEqual(validateUserFollowerCount('22,000'), { ok: true, value: 22000, display: '22,000' });
  assert.deepEqual(validateUserFollowerCount(' 22000 '), { ok: true, value: 22000, display: '22000' });
  assert.deepEqual(validateUserFollowerCount(5079), { ok: true, value: 5079, display: '5079' });
  assert.deepEqual(validateUserFollowerCount('1,234,567'), { ok: true, value: 1234567, display: '1,234,567' });
  assert.equal(validateUserFollowerCount(MAX_USER_FOLLOWER_COUNT).ok, true);
});

test('invalid user input is rejected with a reason and never altered', () => {
  const cases = {
    '0': 'NOT_POSITIVE',
    '-5': 'NOT_POSITIVE',
    '22.5': 'NOT_A_WHOLE_NUMBER',
    '22,000.00': 'NOT_A_WHOLE_NUMBER',
    '22.000': 'NOT_A_WHOLE_NUMBER',
    '22K': 'SHORTHAND_NOT_SUPPORTED',
    '1.5m': 'SHORTHAND_NOT_SUPPORTED',
    'lots': 'MALFORMED',
    '12,34': 'MALFORMED',
    '22 000': 'MALFORMED',
    '1e5': 'MALFORMED',
    '+100': 'MALFORMED',
    '007': 'MALFORMED',
    '': 'EMPTY',
    '   ': 'EMPTY',
    '5,000,000,000': 'TOO_LARGE',
  };
  for (const [input, code] of Object.entries(cases)) {
    const v = validateUserFollowerCount(input);
    assert.equal(v.ok, false, `accepted ${JSON.stringify(input)}`);
    assert.equal(v.code, code, `wrong code for ${JSON.stringify(input)}`);
  }
  assert.equal(validateUserFollowerCount(-1).code, 'NOT_POSITIVE');
  assert.equal(validateUserFollowerCount(0).code, 'NOT_POSITIVE');
  assert.equal(validateUserFollowerCount(12.5).code, 'NOT_A_WHOLE_NUMBER');
  assert.equal(validateUserFollowerCount(NaN).code, 'NOT_A_NUMBER');
  assert.equal(validateUserFollowerCount(MAX_USER_FOLLOWER_COUNT + 1).code, 'TOO_LARGE');
  assert.equal(validateUserFollowerCount(null).code, 'NOT_A_NUMBER');
});

test('user input cannot overwrite an automated count or attach to a missing profile; batch is all-or-nothing', () => {
  const report = beehiivReport();
  const r = by(report);
  assert.equal(applyUserProvidedCount(r.tiktok, '99999').code, 'NOT_ELIGIBLE');
  assert.equal(applyUserProvidedCount(r.instagram, '22000').code, 'NOT_ELIGIBLE');
  const missing = buildResult({ platform: platform('x'), profile: null });
  assert.equal(missing.needsUserInput, false);
  assert.equal(applyUserProvidedCount(missing, '100').code, 'NOT_ELIGIBLE');

  const bad = applyUserProvidedCounts(report, { linkedin: '71,000', x: '12K', myspace: '1' });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors.map((e) => e.code).sort(), ['SHORTHAND_NOT_SUPPORTED', 'UNKNOWN_PLATFORM']);
  assert.equal(by(report).linkedin.followerCount, null, 'original report must be unchanged');

  // A user-provided value may be corrected by the user.
  const once = applyUserProvidedCount(r.linkedin, '70,000').result;
  const twice = applyUserProvidedCount(once, '71,000');
  assert.equal(twice.ok, true);
  assert.equal(twice.result.followerCount, 71000);
});

test('summarizeAudience refuses a count with no or mismatched provenance', () => {
  const r = by(beehiivReport());
  assert.throws(() => summarizeAudience([{ ...r.linkedin, followerCount: 71000 }]), /provenance/);
  assert.throws(() => summarizeAudience([{ ...r.tiktok, sourceType: SOURCE_TYPE.USER_PROVIDED }]), /provenance/);
  assert.throws(() => summarizeAudience([{ ...r.tiktok, status: STATUS.USER_PROVIDED_COUNT }]), /provenance/);
});

test('buildResult will not label a user-provided finding as VERIFIED_COUNT', () => {
  const res = buildResult({
    platform: platform('linkedin'),
    profile: profile('https://www.linkedin.com/company/beehiiv/'),
    finding: { value: 71000, display: '71000', precision: PRECISION.EXACT, sourceType: SOURCE_TYPE.USER_PROVIDED, sourceUrl: 'x', evidence: 'x' },
  });
  assert.equal(res.status, STATUS.PROFILE_FOUND_COUNT_UNAVAILABLE);
  assert.equal(res.followerCount, null);
});

test('planning scenarios: half-up whole numbers, none without an audience', () => {
  assert.deepEqual(planningScenarios(38042).scenarios.map((s) => s.audienceAtPercent), [380, 1141, 1902]);
  assert.deepEqual(planningScenarios(150).scenarios.map((s) => s.audienceAtPercent), [2, 5, 8]); // 1.5, 4.5, 7.5 round up
  assert.equal(planningScenarios(0), null);
  assert.equal(summarizeAudience([]).planningScenarios, null);
});

test('pipeline labels search snippets SEARCH_DERIVED and direct reads AUTO_VERIFIED (mocked network)', async () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.BRAVE_SEARCH_API_KEY;
  process.env.BRAVE_SEARCH_API_KEY = 'test-placeholder';
  const brave = 'https://api.search.brave.com/res/v1/web/search';
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith(brave)) {
      const q = new URL(u).searchParams.get('q');
      const results = q === 'https://www.instagram.com/beehivetest/'
        ? [{ url: q, title: 'beehivetest • Instagram', description: '22K followers, 10 following' }]
        : [];
      return new Response(JSON.stringify({ web: { results } }), { status: 200 });
    }
    const routes = {
      'https://beehivetest.example/robots.txt': [200, ''],
      'https://beehivetest.example': [200, '<a href="https://www.instagram.com/beehivetest/">IG</a><a href="https://www.tiktok.com/@beehivetest">TT</a>'],
      'https://www.instagram.com/robots.txt': [200, 'User-agent: *\nDisallow: /\n'],
      'https://www.tiktok.com/robots.txt': [200, ''],
      'https://www.tiktok.com/@beehivetest': [200, '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">{"__DEFAULT_SCOPE__":{"webapp.user-detail":{"userInfo":{"user":{"uniqueId":"beehivetest"},"stats":{"followerCount":11000},"statsV2":{"followerCount":"10963"}}}}}</script>'],
    };
    const r = routes[u];
    if (!r) throw new Error(`unexpected fetch ${u}`);
    return new Response(r[1], { status: r[0] });
  };
  try {
    const report = await researchCompany('https://beehivetest.example', { useSearch: true });
    const r = by(report);
    assert.equal(r.instagram.sourceType, SOURCE_TYPE.SEARCH_DERIVED);
    assert.equal(r.instagram.followerCountDisplay, '22K');
    assert.equal(r.instagram.followerCountPrecision, PRECISION.ROUNDED_BY_SOURCE);
    assert.equal(r.tiktok.sourceType, SOURCE_TYPE.AUTO_VERIFIED);
    assert.equal(r.tiktok.followerCount, 10963);
    assert.equal(report.audience.publiclySourced.total, 32963);
    assert.equal(report.audience.userProvided.total, 0);
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
    else process.env.BRAVE_SEARCH_API_KEY = realKey;
  }
});
