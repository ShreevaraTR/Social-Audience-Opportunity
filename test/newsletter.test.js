// Newsletter strategy generator. Offline: inputs are built from synthetic homepage HTML
// through the same extractors and audience functions the engine uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResult, SOURCE_TYPE, PRECISION } from '../src/research.js';
import { summarizeAudience, applyUserProvidedCounts } from '../src/audience.js';
import { extractCompanyInfo } from '../src/company.js';
import { PLATFORMS } from '../src/platforms.js';
import {
  generateNewsletterStrategy,
  buildStrategyInput,
  validateStrategy,
  deterministicStrategyProvider,
  StrategyValidationError,
} from '../src/newsletter.js';

const platform = (key) => PLATFORMS.find((p) => p.key === key);
const profile = (url) => ({ url, discoveredVia: 'company website (anchor)', official: true });

function report(url, html, results = []) {
  const site = { url, finalUrl: url, reachable: html !== null, blockedReason: html === null ? 'network error' : null, ...extractCompanyInfo(html ?? '', url) };
  return { companyUrl: url, site, results, audience: summarizeAudience(results) };
}

// A synthetic B2B SaaS homepage (not a real company).
const SAAS_HTML = `<html><head><title>Flowboard - Project planning for product teams</title>
<meta name="description" content="Flowboard is the workflow and project planning tool for product teams. Plan roadmaps, automate handoffs and ship faster.">
</head><body>
<h1>Plan, track and ship work as a team</h1>
<h2>Roadmaps and planning</h2><h2>Workflow automation</h2><h2>Integrations</h2>
<a href="/login">Log in</a><a href="/blog">Blog</a><a href="/customers">Customer stories</a><a href="/startups">Startups</a>
<a href="/community">Community</a><a href="/webinars">Webinars</a>
</body></html>`;

// Shaped like the beehiiv homepage structure observed during research (headings + nav).
const CREATOR_HTML = `<html><head><title>Newsletter Platform: Create Newsletters and Websites - beehiiv</title>
<meta name="description" content="Create, grow, and monetize your newsletter with easy-to-use newsletter tools. Build email newsletters and websites without any coding.">
<script type="application/ld+json">{"@type":"Organization","name":"beehiiv"}</script></head><body>
<h1>NEWSLETTERS. PODCASTS. COMMUNITY. ONE PLATFORM.</h1>
<h2>Everything you need to turn attention into growth.</h2>
<h3>Newsletters</h3><h3>Podcasts</h3><h3>Digital Products</h3><h3>Monetization</h3><h3>Community</h3><h3>Websites</h3>
<a>Recommendations</a><a>Subscribe Forms</a><a>Referral Program</a><a>Ad Network</a><a>Paid Subscriptions</a>
<a>Analytics</a><a>Blog</a><a>Live Events</a><a>Log in</a><a>Creators &amp; Publishers</a><a>Newsletter Businesses</a><a>Media Companies</a>
</body></html>`;

function beehiivResults() {
  return [
    buildResult({ platform: platform('linkedin'), profile: profile('https://www.linkedin.com/company/beehiiv/') }),
    buildResult({
      platform: platform('instagram'),
      profile: profile('https://www.instagram.com/beehiiv/'),
      finding: { value: 22000, display: '22K', precision: PRECISION.ROUNDED_BY_SOURCE, sourceType: SOURCE_TYPE.SEARCH_DERIVED, sourceUrl: 'https://www.instagram.com/beehiiv/', evidence: 'snippet "22K followers"' },
    }),
    buildResult({ platform: platform('x'), profile: profile('https://x.com/beehiiv') }),
    buildResult({
      platform: platform('facebook'),
      profile: profile('https://www.facebook.com/trybeehiiv'),
      finding: { value: 5079, display: '5,079', precision: PRECISION.EXACT, sourceType: SOURCE_TYPE.SEARCH_DERIVED, sourceUrl: 'https://www.facebook.com/trybeehiiv/', evidence: 'snippet "5,079 followers"' },
    }),
    buildResult({
      platform: platform('tiktok'),
      profile: profile('https://www.tiktok.com/@beehiiv'),
      finding: { value: 10963, display: '10963', precision: PRECISION.EXACT, sourceType: SOURCE_TYPE.AUTO_VERIFIED, sourceUrl: 'https://www.tiktok.com/@beehiiv', evidence: 'statsV2.followerCount "10963"' },
    }),
  ];
}

const allText = (s) => JSON.stringify(s);
// Only the human-readable strategy text (ids such as "b2b-software" are not claims).
const strategyText = (s) =>
  [s.whyNewsletterMakesSense, s.recommendedFormat.title, s.recommendedFormat.description, ...s.contentThemes.flatMap((t) => [t.title, t.description]), s.firstIssue.title, s.firstIssue.concept, ...s.acquisitionChannels.flatMap((c) => [c.title, c.description])].join('\n');

test('SaaS example: exactly 3 company-specific content themes', async () => {
  const s = await generateNewsletterStrategy(report('https://flowboard.example/', SAAS_HTML));
  assert.equal(s.archetype.id, 'b2b-software');
  assert.equal(s.contentThemes.length, 3);
  for (const t of s.contentThemes) {
    assert.ok(t.title.trim() && t.description.trim());
    assert.doesNotMatch(t.title, /^(industry news|company updates|tips and tricks)$/i);
  }
  // Themes cite the company's own website wording.
  assert.ok(s.contentThemes.some((t) => /Roadmaps and planning|Workflow automation/.test(t.description)));
  assert.match(s.whyNewsletterMakesSense, /Flowboard describes itself as “Flowboard is the workflow and project planning tool for product teams/);
});

test('first issue has a title and a concept; recommended format has a title and a description', async () => {
  for (const html of [SAAS_HTML, CREATOR_HTML]) {
    const s = await generateNewsletterStrategy(report('https://www.beehiiv.com/', html));
    assert.ok(s.firstIssue.title.length > 5);
    assert.ok(s.firstIssue.concept.split(/[.!?]\s/).length >= 2, 'concept should be 2-4 sentences');
    assert.ok(s.recommendedFormat.title.length > 5);
    assert.ok(s.recommendedFormat.description.length > 40);
  }
});

test('beehiiv-like research: creator strategy grounded in its own wording and audience', async () => {
  const s = await generateNewsletterStrategy(report('https://www.beehiiv.com/', CREATOR_HTML, beehiivResults()));
  assert.equal(s.companyName, 'beehiiv');
  assert.equal(s.archetype.id, 'creator-platform');
  assert.equal(s.dataQuality, 'GOOD');
  const themeTitles = s.contentThemes.map((t) => t.title);
  assert.ok(themeTitles.includes('Audience growth playbooks') && themeTitles.includes('Monetization in practice'), themeTitles.join(', '));
  assert.match(s.recommendedFormat.description, /Creators & Publishers, Newsletter Businesses and Media Companies/);
  assert.match(s.firstIssue.concept, /“Recommendations” and “Subscribe Forms”/);
  assert.match(s.whyNewsletterMakesSense, /38,042 followers across 3 platforms/);
  const titles = s.acquisitionChannels.map((c) => c.title);
  assert.deepEqual(titles.slice(0, 2), ['Existing social audience', 'Company website']);
  assert.ok(titles.includes('Existing product users') && titles.includes('Blog & SEO content') && titles.includes('Events & webinars'));
  const social = s.acquisitionChannels[0];
  assert.match(social.description, /Instagram \(22K\), TikTok \(10,963\) and Facebook \(5,079\)/);
  assert.match(social.description, /LinkedIn and X profiles were also found/);
});

test('strategy never invents follower counts or other numbers', async () => {
  const cases = [
    report('https://www.beehiiv.com/', CREATOR_HTML, beehiivResults()),
    report('https://flowboard.example/', SAAS_HTML),
    report('https://nothing.example/', null),
  ];
  for (const r of cases) {
    const s = await generateNewsletterStrategy(r);
    const input = buildStrategyInput(r);
    const allowed = new Set([...input.platforms.flatMap((p) => [p.followerCount, p.followerCountDisplay]), input.audience.total, input.audience.platformCount].filter((v) => v != null).map((v) => String(v).replace(/,/g, '')));
    const numbers = [...strategyText(s).matchAll(/\d[\d,.]*[KMB]?/g)].map((m) => m[0].replace(/,/g, '').replace(/\.$/, ''));
    for (const n of numbers) assert.ok(allowed.has(n), `number ${n} is not from the research`);
  }
  // With no counts at all, no follower figure appears anywhere.
  const s = await generateNewsletterStrategy(report('https://flowboard.example/', SAAS_HTML));
  assert.doesNotMatch(strategyText(s), /\d/);
});

test('validator rejects fabricated numbers and wrong theme counts', () => {
  const r = report('https://www.beehiiv.com/', CREATOR_HTML, beehiivResults());
  const input = buildStrategyInput(r);
  const good = {
    whyNewsletterMakesSense: 'x',
    recommendedFormat: { title: 'a', description: 'b' },
    contentThemes: [1, 2, 3].map(() => ({ title: 't', description: 'd' })),
    firstIssue: { title: 't', concept: 'c' },
    acquisitionChannels: [{ title: 'Social', description: 'Invite TikTok (10,963) followers.' }],
  };
  assert.doesNotThrow(() => validateStrategy(good, input));
  assert.throws(() => validateStrategy({ ...good, whyNewsletterMakesSense: 'Reach 50,000 subscribers.' }, input), StrategyValidationError);
  assert.throws(() => validateStrategy({ ...good, contentThemes: good.contentThemes.slice(0, 2) }, input), /exactly 3/);
  assert.throws(() => validateStrategy({ ...good, firstIssue: { title: 't' } }, input), /firstIssue/);
});

test('missing company information is handled gracefully', async () => {
  const r = report('https://nothing.example/', null, [buildResult({ platform: platform('x'), profile: null })]);
  const s = await generateNewsletterStrategy(r);
  assert.equal(s.companyName, 'nothing.example');
  assert.equal(s.archetype.id, 'general');
  assert.equal(s.dataQuality, 'LIMITED');
  assert.equal(s.contentThemes.length, 3);
  assert.ok(s.firstIssue.title && s.firstIssue.concept);
  assert.match(s.firstIssue.concept, /limited public information/i);
  assert.ok(s.whyNewsletterMakesSense.length > 20);
  assert.deepEqual(s.acquisitionChannels.map((c) => c.title), ['Company website']);
  // No report fields at all.
  const bare = await generateNewsletterStrategy({ companyUrl: 'https://bare.example/' });
  assert.equal(bare.contentThemes.length, 3);
});

test('user-provided counts flow into the strategy, labelled as user provided', async () => {
  const base = report('https://www.beehiiv.com/', CREATOR_HTML, beehiivResults());
  const applied = applyUserProvidedCounts(base, { linkedin: '71,000', x: '12,000' });
  assert.equal(applied.ok, true);
  const s = await generateNewsletterStrategy({ ...base, ...applied.report });
  assert.match(s.whyNewsletterMakesSense, /121,042 followers across 5 platforms \(including user-provided figures\)/);
  assert.match(s.acquisitionChannels[0].description, /LinkedIn \(71,000, user provided\)/);
  assert.match(s.acquisitionChannels[0].description, /X \(12,000, user provided\)/);
  assert.doesNotMatch(allText(s), /verified/i);
});

test('deterministic and cached: same research gives the same strategy', async () => {
  const r = report('https://flowboard.example/', SAAS_HTML);
  const a = await generateNewsletterStrategy(r);
  const b = await generateNewsletterStrategy(structuredClone(r));
  assert.deepEqual(a, b);
  assert.equal(a.generatedBy.id, deterministicStrategyProvider.id);
});

test('a pluggable provider is used when valid, and replaced by the deterministic one when it fabricates', async () => {
  const r = report('https://flowboard.example/', SAAS_HTML);
  const valid = {
    id: 'fake-llm',
    kind: 'LLM',
    label: 'Test provider',
    generate: async (input) => ({
      whyNewsletterMakesSense: `${input.company.name} could own its audience.`,
      recommendedFormat: { title: 'Format', description: 'Desc' },
      contentThemes: ['A', 'B', 'C'].map((t) => ({ title: t, description: `${t} desc` })),
      firstIssue: { title: 'Issue', concept: 'Concept.' },
      acquisitionChannels: [],
    }),
  };
  const used = await generateNewsletterStrategy(r, { provider: valid });
  assert.equal(used.generatedBy.id, 'fake-llm');
  assert.equal(used.contentThemes[0].title, 'A');

  const fabricating = { ...valid, id: 'fabricating-llm', generate: async (input) => ({ ...(await valid.generate(input)), whyNewsletterMakesSense: 'It has 250,000 loyal subscribers.' }) };
  const fellBack = await generateNewsletterStrategy(r, { provider: fabricating });
  assert.equal(fellBack.generatedBy.id, deterministicStrategyProvider.id);
  assert.equal(fellBack.generatedBy.fallbackFrom, 'fabricating-llm');
  assert.match(fellBack.generatedBy.fallbackReason, /250,000/);
  assert.doesNotMatch(strategyText(fellBack), /250,000/);
});

test('homepage headings and link labels are extracted without boilerplate or repetition', () => {
  const info = extractCompanyInfo(
    '<h1>The system for teams The system for teams</h1><h2>Privacy policy</h2><h2>Planning</h2><h2>Planning</h2><a href="/x">Log in</a><a href="mailto:a@b.co">a@b.co</a><a>Terms of service</a>',
    'https://acme.example/',
  );
  assert.deepEqual(info.headings, [{ level: 1, text: 'The system for teams' }, { level: 2, text: 'Planning' }]);
  assert.deepEqual(info.navLabels, ['Log in']);
});
