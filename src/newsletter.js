// Newsletter strategy: research -> strategy input (facts only) -> provider -> validated strategy.
//
//   buildStrategyInput(report)        the facts a provider may use: the homepage's own name,
//                                     description, headings and link labels, the discovered
//                                     profiles and the audience summary. Nothing else.
//   deterministicStrategyProvider     rule-based generator (no AI model, no network).
//   validateStrategy(strategy, input) schema check + anti-fabrication check: every number in
//                                     the output must appear in the input.
//   generateNewsletterStrategy(report, { provider })
//                                     runs a provider, validates, falls back to the
//                                     deterministic provider if another provider's output
//                                     is rejected. An LLM provider can be plugged in here
//                                     ({ id, kind, async generate(input) }) without changing
//                                     the API contract or the UI.
//
// The strategy is a recommendation, not research. Researched facts appear only as quoted
// website text or audience figures, and each section lists the facts it is based on.

import { SOURCE_TYPE, PRECISION } from './model.js';

const fmt = (n) => n.toLocaleString('en-US');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const lower = (s) => s.toLowerCase();
const listJoin = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const quote = (s) => `“${s}”`;
const poss = (name) => (/s$/i.test(name) ? `${name}’` : `${name}’s`);

/** Leading sentence(s) of a description, up to ~160 chars, without trailing CTAs. */
function leadSentences(text, max = 160) {
  const sentences = text.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [text];
  let out = '';
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (out && (out.length + sentence.length > max || /\b(try|sign up|get started|free)\b/i.test(sentence))) break;
    out = out ? `${out} ${sentence}` : sentence;
  }
  return clip(out, max + 40).replace(/[.!]$/, '');
}

// ------------------------------------------------------------------ input (facts only)

/** The facts a strategy provider receives. Anything not in here must not be asserted. */
export function buildStrategyInput(report) {
  const site = report.site ?? {};
  let host = null;
  try {
    host = new URL(report.companyUrl).hostname.replace(/^www\./, '');
  } catch {
    /* leave null */
  }
  const total = report.audience?.totalAudienceFootprint;
  return {
    company: {
      name: site.name || host || 'this company',
      website: site.finalUrl || report.companyUrl || null,
      host,
      websiteReachable: site.reachable !== false,
      description: site.description || null,
      headings: site.headings ?? [],
      navLabels: site.navLabels ?? [],
    },
    platforms: (report.results ?? [])
      .filter((r) => r.profileFound)
      .map((r) => ({
        platform: r.platform,
        platformKey: r.platformKey,
        profileUrl: r.profileUrl,
        status: r.status,
        followerCount: r.followerCount,
        followerCountDisplay: r.followerCountDisplay,
        followerCountPrecision: r.followerCountPrecision,
        sourceType: r.sourceType,
      })),
    audience: {
      total: total?.total ?? 0,
      platformCount: total?.platformCount ?? 0,
      includesUserProvided: Boolean(total?.includesUserProvided),
      includesRoundedValues: Boolean(total?.includesRoundedValues),
    },
  };
}

// ------------------------------------------------------------------ signals from the input

// Keywords are regex sources matched from a word start.
const rx = (k) => new RegExp(`\\b${k}`, 'i');

function sources(input) {
  const c = input.company;
  const out = [];
  if (c.description) out.push({ text: c.description, weight: 3, kind: 'description' });
  for (const h of c.headings) out.push({ text: h.text, weight: h.level === 1 ? 3 : h.level === 2 ? 2 : 1, kind: 'heading' });
  for (const n of c.navLabels) out.push({ text: n, weight: 1, kind: 'nav' });
  return out;
}

/** Sum of the best weight of each distinct keyword found. */
function score(srcs, keywords) {
  let total = 0;
  for (const k of keywords) {
    const re = rx(k);
    let best = 0;
    for (const s of srcs) if (s.weight > best && re.test(s.text)) best = s.weight;
    total += best;
  }
  return total;
}

/** Short website phrases (headings first, then link labels) that contain any keyword. */
function evidence(srcs, keywords, name, max = 2, exclude = new Set()) {
  const res = keywords.map(rx);
  const hits = [];
  for (const kind of ['heading', 'nav', 'description']) {
    for (const s of srcs) {
      if (s.kind !== kind || s.text.length > 40 || lower(s.text) === lower(name) || exclude.has(lower(s.text))) continue;
      const overlaps = hits.some((h) => lower(h.text).includes(lower(s.text)) || lower(s.text).includes(lower(h.text)));
      if (res.some((re) => re.test(s.text)) && !overlaps) hits.push(s);
      if (hits.length >= max) return hits;
    }
  }
  return hits;
}

const basisOf = (hits) => hits.map((h) => `Website ${h.kind === 'nav' ? 'link' : h.kind} ${quote(h.text)}`);

function tagline(input) {
  for (const h of input.company.headings) {
    if (h.level > 2 || h.text === h.text.toUpperCase() || /\?$/.test(h.text) || !/^[A-Z0-9]/.test(h.text)) continue;
    const first = h.text.match(/^.+?[.!](?=\s|$)/)?.[0] ?? h.text;
    if (first.length >= 15 && first.length <= 140) return { text: first.replace(/\.$/, ''), basis: `Website heading ${quote(clip(first, 60))}` };
  }
  if (input.company.description) return { text: clip(input.company.description.replace(/\.$/, ''), 160), basis: 'Website meta description' };
  return null;
}

const GENERIC_HEADINGS = /^(product|products|features|company|resources|connect|legal|pricing|changelog|faq|support|about|about us|blog|careers|men'?s|women'?s|mens|womens|customer favorites|popular picks|new arrivals|best sellers|shop|explore|learn more|get started|contact|home)$|^(explore|frequently asked|trusted by|what['’]s|get |learn |read |meet |why |how it works|join |follow )/i;

/** Short headings naming what the company offers ("Newsletters", "Planning and monitoring"). */
function focusAreas(input, max = 6) {
  const out = [];
  const byLevel = [...input.company.headings].sort((a, b) => a.level - b.level);
  for (const h of byLevel) {
    const words = h.text.split(/\s+/).length;
    if (h.level === 1 || words > 4 || !/^[A-Z0-9]/.test(h.text) || GENERIC_HEADINGS.test(h.text) || h.text === h.text.toUpperCase()) continue;
    if (lower(h.text) === lower(input.company.name) || out.some((o) => lower(o) === lower(h.text))) continue;
    out.push(h.text.replace(/[.!]$/, ''));
    if (out.length >= max) break;
  }
  return out;
}

const SEGMENT_END = /\b(creators|publishers|businesses|companies|teams|startups|enterprises|developers|employers|providers|agencies|educators|students|nonprofits|advertisers|platforms|marketers)$/i;

/** Audiences the website itself names ("Media Companies", "beehiiv for Advertisers"). */
function segments(input, max = 4) {
  const out = [];
  const push = (seg) => !out.some((o) => lower(o) === lower(seg)) && out.push(seg);
  const labels = input.company.navLabels.filter((l) => !/^(get|start|try|contact|become|join|sign|log|view|see|read)\b/i.test(l));
  for (const l of labels) if (!/\bfor\b/i.test(l) && SEGMENT_END.test(l) && l.split(' ').length <= 3) push(l);
  for (const l of labels) {
    const seg = l.match(/^(?:.+\s)?for\s+(.+)$/i)?.[1];
    const covered = seg && out.some((o) => lower(o).includes(lower(seg).replace(/e?s$/, '')));
    if (seg && !covered && !/^(you|free|everyone|all|more)$/i.test(seg)) push(seg);
  }
  return out.slice(0, max);
}

// ------------------------------------------------------------------ archetypes

// Each archetype: detection keywords, a recommended format, a theme pool (the three best
// supported by the website are chosen) and a first-issue concept. Wording is deliberately
// a recommendation ("could", "would") and never asserts facts beyond the input.
const ARCHETYPES = [
  {
    id: 'creator-platform',
    label: 'Newsletter / creator platform',
    keywords: ['newsletter', 'podcast', 'creator', 'publisher', 'publishing', 'subscriber', 'monetiz', 'sponsorship', 'paid subscription', 'audience', 'writer'],
    format: (c) => ({
      title: 'Weekly growth & monetization playbook',
      description: `${poss(c.name)} website centers on ${c.taglinePhrase('growing and monetizing an audience')}. A weekly playbook — one tactic, one worked example, one next step — would put that expertise to work for ${c.segmentsText('creators and publishers')}, and would itself demonstrate the kind of newsletter the product is built for.`,
    }),
    themes: [
      { title: 'Audience growth playbooks', keywords: ['grow', 'growth', 'referral', 'recommendation', 'subscribe form', 'pop-up', 'magic link', 'audience'], description: 'Practical tactics for turning social reach and website visitors into subscribers.' },
      { title: 'Monetization in practice', keywords: ['monetiz', 'paid subscription', 'ad network', 'sponsorship', 'digital product', 'revenue', 'earn'], description: 'How publishers can earn from an owned audience, from paid subscriptions to sponsorships and digital products.' },
      { title: 'Data-driven publishing', keywords: ['analytics', 'a/b test', 'segmentation', 'survey', 'poll', 'verified click'], description: 'Using analytics, testing and segmentation to decide what to send, and to whom.' },
      { title: 'Publisher case studies', keywords: ['customer stor', 'creator spotlight', 'case stud', 'trusted by'], description: 'Short breakdowns of how individual publishers run and grow their newsletters.' },
      { title: 'Beyond the inbox', keywords: ['podcast', 'website', 'community', 'digital product'], description: 'Ideas for extending a newsletter into podcasts, websites and community.' },
    ],
    issueKeywords: ['referral', 'recommendation', 'subscribe form', 'pop-up', 'magic link', 'grow'],
    firstIssue: (c) => ({
      title: 'From Followers to Subscribers: Who Really Owns Your Audience?',
      concept: `Open with the difference between social reach, which each platform controls, and a subscriber list the publisher owns. Then lay out a simple starting framework using the kinds of growth tools ${c.name} highlights${c.issueEvidence}, and preview ${quote(c.themes[1].title)} as the next issue. It is a natural first issue because it mirrors ${poss(c.name)} own positioning${c.taglineQuote}.`,
    }),
  },
  {
    id: 'developer-platform',
    label: 'Developer platform',
    keywords: ['developer', 'api\\b', 'sdk', 'docs\\b', 'documentation', 'deploy', 'infrastructure', 'open source', 'github', 'cli\\b', 'framework'],
    format: (c) => ({
      title: 'Monthly technical deep-dive + release digest',
      description: `Based on ${poss(c.name)} developer-focused positioning${c.taglineQuote}, depth is likely to matter more than frequency: each issue could pair one hands-on technical deep-dive with a short digest of what is new.`,
    }),
    themes: [
      { title: 'Build guides', keywords: ['docs\\b', 'guide', 'tutorial', 'quickstart', 'integration', 'api\\b', 'sdk', 'template'], description: 'Hands-on walkthroughs showing how to build with the product, step by step.' },
      { title: 'Performance & reliability', keywords: ['infrastructure', 'scale', 'performance', 'reliab', 'security', 'uptime', 'edge', 'fast'], description: 'Explainers on the engineering trade-offs behind fast, reliable systems.' },
      { title: 'Releases, explained', keywords: ['changelog', 'release', 'launch', 'new\\b', 'announcement'], description: 'Practical context on recent releases and how to adopt them.' },
      { title: 'Ecosystem & open source', keywords: ['open source', 'github', 'community', 'plugin', 'marketplace', 'integrations'], description: 'Highlights from the surrounding ecosystem and community projects.' },
    ],
    issueKeywords: ['docs\\b', 'documentation', 'guide', 'quickstart', 'tutorial'],
    firstIssue: (c) => ({
      title: `Building with ${c.name}: One Project, End to End`,
      concept: `Walk through one complete example, from setup to a working result, using ${poss(c.name)} own documentation as the reference${c.issueEvidence}. Explain why each step matters, not just what to type. It is a logical start because it gives new readers something useful on day one and sets the tone for hands-on issues.`,
    }),
  },
  {
    id: 'fintech',
    label: 'Payments / financial software',
    keywords: ['payment', 'billing', 'invoic', 'revenue', 'financial', 'banking', 'payout', 'card issuing', 'crypto', 'checkout', 'tax\\b', 'money'],
    format: (c) => ({
      title: 'Monthly revenue & payments briefing',
      description: `${poss(c.name)} public positioning centers on ${c.taglinePhrase('payments and revenue')}. A concise briefing that explains one change or decision in payments, billing or finance operations, with a practical takeaway, fits a topic readers need to get right.`,
    }),
    themes: [
      { title: 'Checkout & payment optimization', keywords: ['payment', 'checkout', 'optimi', 'authorization', 'conversion', 'payment link'], description: 'Practical ways to reduce friction and failed payments at checkout.' },
      { title: 'Billing & revenue models', keywords: ['billing', 'subscription', 'invoic', 'pricing', 'revenue model', 'revenue recognition'], description: 'How businesses structure pricing, billing and recurring revenue.' },
      { title: 'Global money movement', keywords: ['global', 'borderless', 'cross-border', 'payout', 'currenc', 'stablecoin', 'crypto', 'money movement'], description: 'Explainers on moving money across borders and on newer payment rails.' },
      { title: 'Fraud, identity & compliance', keywords: ['fraud', 'radar', 'identity', 'compliance', 'security', 'tax\\b'], description: 'What finance and product teams should know about fraud, identity and compliance.' },
      { title: 'Building the revenue stack', keywords: ['startup', 'enterprise', 'platform', 'saas', 'customer stor'], description: 'How businesses at different stages assemble their payments and revenue tools.' },
    ],
    issueKeywords: ['payment', 'billing', 'payout', 'invoic'],
    firstIssue: (c) => ({
      title: 'The Revenue Stack, Explained',
      concept: `Map the building blocks of a modern revenue stack, from accepting payments to billing and payouts, using the product areas ${c.name} highlights${c.issueEvidence}. Close with a short checklist readers can use to review their own setup. It is a strong opener because every later issue can build on the same mental model.`,
    }),
  },
  {
    id: 'b2b-software',
    label: 'B2B software',
    keywords: ['team', 'workflow', 'product development', 'planning', 'collaborat', 'automation', 'agents?\\b', 'enterprise', 'project', 'roadmap', 'productivity'],
    format: (c) => ({
      title: 'Biweekly operator playbook',
      description: `Based on ${poss(c.name)} focus on ${c.focusText('how teams work')}, a practical playbook — one workflow, how to run it, and what to watch — would deliver useful insight rather than product announcements.`,
    }),
    themes: [
      { title: 'Planning & workflow playbooks', keywords: ['workflow', 'planning', 'plan\\b', 'process', 'method', 'roadmap', 'project', 'intake'], description: 'Step-by-step approaches to planning, prioritizing and running work.' },
      { title: 'AI & automation in practice', keywords: ['ai\\b', 'agents?\\b', 'automation', 'automate', 'copilot'], description: 'Grounded examples of where AI and automation help day-to-day work, and where they do not.' },
      { title: 'Building & shipping with quality', keywords: ['quality', 'review', 'ship', 'build', 'craft', 'design'], description: 'Principles for building, reviewing and shipping high-quality work as a team.' },
      { title: 'Connecting your tools', keywords: ['integration', 'api\\b', 'connect', 'sync', 'docs\\b'], description: 'How to connect the tools teams already use into one workflow.' },
      { title: 'Lessons from other teams', keywords: ['customer stor', 'customers', 'case stud', 'startups', 'enterprise'], description: 'What different teams have learned running their process.' },
    ],
    issueKeywords: ['planning', 'plan\\b', 'workflow', 'intake', 'roadmap', 'project'],
    firstIssue: (c) => ({
      title: 'How High-Performing Teams Plan Their Work',
      concept: `Introduce a simple, repeatable approach to planning and tracking work, drawing on the areas ${c.name} emphasizes${c.issueEvidence}. Include a lightweight template readers can adapt this week. It works as a first issue because it is immediately useful and reflects the problem ${c.name} focuses on${c.taglineQuote}.`,
    }),
  },
  {
    id: 'ecommerce',
    label: 'Consumer brand / e-commerce',
    keywords: ['shoes', 'apparel', 'sneaker', 'shop\\b', 'cart\\b', 'new arrival', 'best seller', 'collection', 'accessor', 'materials', 'returns'],
    format: (c) => ({
      title: 'Brand story + curated product edit',
      description: `Based on ${poss(c.name)} storefront, pairing one product story (materials, design or care) with a short curated edit would give readers a reason to open each issue beyond promotions.`,
    }),
    themes: [
      { title: 'Behind the product', keywords: ['material', 'making', 'design', 'sustainab', 'natural', 'our story'], description: 'How the products are designed and made, and the choices behind them.' },
      { title: 'Curated edits', keywords: ['new arrival', 'best seller', 'essentials', 'collection', 'favorite', 'colors', 'picks'], description: 'Seasonal or themed selections from the catalog.' },
      { title: 'Care & fit guides', keywords: ['care\\b', 'fit\\b', 'guide', 'faq', 'size'], description: 'Practical guidance for choosing products and making them last.' },
      { title: 'Community & stories', keywords: ['community', 'blog', 'press', 'stories', 'flock'], description: 'Stories from the brand’s blog and community.' },
    ],
    issueKeywords: ['our story', 'material', 'making', 'design'],
    firstIssue: (c) => ({
      title: `Welcome to ${c.name}: What We Make and Why`,
      concept: `Introduce the brand through its own story${c.issueEvidence}, then feature a short curated edit from the current catalog. It works as a welcome issue because it explains what makes the products distinctive before any promotion.`,
    }),
  },
  {
    id: 'health-wellness',
    label: 'Health & wellbeing',
    keywords: ['meditat', 'mindful', 'sleep', 'mental health', 'therapy', 'wellness', 'wellbeing', 'anxiety', 'stress', 'fitness'],
    format: (c) => ({
      title: 'Weekly practice newsletter',
      description: `Based on ${poss(c.name)} focus on ${c.focusText('wellbeing')}, a short weekly issue with one idea and one simple practice to try would give readers steady, usable value without making health claims.`,
    }),
    themes: [
      { title: 'Everyday practices', keywords: ['meditat', 'mindful', 'practice', 'breath', 'guided'], description: 'Short, guided practices readers can try in a few minutes.' },
      { title: 'Sleep & rest', keywords: ['sleep', 'rest\\b', 'white noise', 'relax'], description: 'Practical habits for better sleep and rest.' },
      { title: 'Stress & focus at work', keywords: ['stress', 'anxiety', 'at work', 'focus', 'flow'], description: 'Approaches for managing stress and staying focused during the workday.' },
      { title: 'The research, in plain language', keywords: ['science', 'research', 'study'], description: 'Accessible explanations of the research behind the practices.' },
      { title: 'Wellbeing at home', keywords: ['famil', 'parent', 'kids'], description: 'Ideas for bringing the practices into family life.' },
    ],
    issueKeywords: ['meditat', 'mindful', 'breath', 'guided'],
    firstIssue: (c) => ({
      title: 'A Simple Reset You Can Try Today',
      concept: `Open with one short practice readers can try immediately, drawn from the areas ${c.name} covers${c.issueEvidence}, then explain in plain language how it works. Close with a preview of the next topic. It is a welcoming first issue because it delivers something useful before asking anything of the reader.`,
    }),
  },
  {
    id: 'education',
    label: 'Education / learning',
    keywords: ['course', 'lesson', 'student', 'teacher', 'learn', 'curriculum', 'class\\b', 'tutor'],
    format: (c) => ({
      title: 'Weekly mini-lesson newsletter',
      description: `Based on ${poss(c.name)} focus on ${c.focusText('learning')}, one short, self-contained lesson per issue would give readers a steady learning habit.`,
    }),
    themes: [
      { title: 'Mini-lessons', keywords: ['course', 'lesson', 'learn', 'class\\b'], description: 'Short, self-contained lessons readers can finish in one sitting.' },
      { title: 'How to learn better', keywords: ['study', 'practice', 'skill', 'method'], description: 'Techniques for studying and retaining new skills.' },
      { title: 'For educators', keywords: ['teacher', 'educator', 'curriculum', 'classroom'], description: 'Ideas and resources for people who teach.' },
      { title: 'Learner journeys', keywords: ['student', 'stories', 'community'], description: 'How individual learners approached a new skill.' },
    ],
    issueKeywords: ['course', 'lesson', 'learn'],
    firstIssue: (c) => ({
      title: 'Your First Lesson',
      concept: `Deliver one complete mini-lesson connected to what ${c.name} teaches${c.issueEvidence}, then explain what future issues will cover. It is a logical start because readers experience the value immediately.`,
    }),
  },
];

const GENERIC = {
  id: 'general',
  label: 'General',
  format: (c) => ({
    title: 'Monthly insights newsletter',
    description: `Based on ${poss(c.name)} public positioning${c.taglineQuote}, an appropriate direction could be a monthly issue sharing one useful insight connected to its work, plus a practical takeaway.`,
  }),
  firstIssue: (c) => ({
    title: `Why ${c.name} Exists`,
    concept: `Introduce the problem ${c.name} focuses on${c.input.company.description ? `, as described on its website (${quote(leadSentences(c.input.company.description, 140))})` : ''}, and what readers can expect from future issues. ${c.limited ? 'With limited public information available, this issue should be drafted with input from the company itself.' : 'It sets expectations and gives readers a reason to stay subscribed.'}`,
  }),
};

function genericThemes(c) {
  const themes = c.focus.slice(0, 3).map((f) => ({
    title: f,
    description: `Explainers and practical guidance on ${lower(f)}, one of the areas ${c.name} highlights on its website.`,
    basis: [`Website heading ${quote(f)}`],
  }));
  const fillers = [
    { title: `What ${c.name} is working on`, description: 'Context on the problems the company focuses on, framed as insight rather than announcements.', basis: c.input.company.description ? ['Website meta description'] : [] },
    { title: 'Practical guides', description: `Useful how-tos related to ${poss(c.name)} field, drafted with the company's own expertise.`, basis: [] },
    { title: 'Questions from readers', description: 'Answers to questions subscribers send in, which also shows what the audience cares about.', basis: [] },
  ];
  for (const f of fillers) if (themes.length < 3) themes.push(f);
  return themes;
}

// ------------------------------------------------------------------ acquisition channels

const CHANNEL_RULES = [
  { key: 'product', title: 'Existing product users', match: /^(log ?in|sign ?in|open app|dashboard|my account)$/i, description: (c, l) => `Offer newsletter opt-in during sign-up and inside the product, reaching people who already use ${c.name} (the website links to ${quote(l)}).` },
  { key: 'content', title: 'Blog & SEO content', match: /^(our |the )?(blog|resources|guides|library|help center|articles|academy|insights|newsroom|learn)$/i, description: (c, l) => `Add subscribe prompts to ${poss(c.name)} existing ${quote(l)} pages and repurpose that content into issues.` },
  { key: 'events', title: 'Events & webinars', match: /^([\w-]+ )?(events?|webinars?|events and webinars|conferences?|summit)$/i, description: (c, l) => `Invite people who attend ${poss(c.name)} ${quote(l)} to subscribe for follow-ups and recordings.` },
  { key: 'partners', title: 'Partnerships', match: /^(partners|become a partner|partner program|affiliates?|affiliate program|brand partners|[\w-]+ experts)$/i, description: (c, l) => `Co-promote the newsletter with partners, building on ${poss(c.name)} existing ${quote(l)} pages.` },
  { key: 'referral', title: 'Referral loop', match: /^(referral program|referrals?|refer a friend|refer and earn)$/i, description: (c, l) => `Reward subscribers for sharing, building on the ${quote(l)} mechanism the website already features.` },
  { key: 'community', title: 'Community', match: /^(community|our community|join the community|forum|forums|discord|slack community)$/i, description: (c, l) => `Share each issue with ${poss(c.name)} ${quote(l)} and invite members to subscribe.` },
  { key: 'video', title: 'Video & podcast', match: /^(youtube|podcasts?)$/i, description: (c, l) => `Mention the newsletter in ${poss(c.name)} ${l} content and descriptions.` },
];

function countText(p) {
  const n = p.followerCountPrecision === PRECISION.ROUNDED_BY_SOURCE ? p.followerCountDisplay : fmt(p.followerCount);
  return `${p.platform} (${n}${p.sourceType === SOURCE_TYPE.USER_PROVIDED ? ', user provided' : ''})`;
}

function acquisitionChannels(c, max = 6) {
  const { input } = c;
  const channels = [];
  const counted = input.platforms.filter((p) => p.followerCount !== null).sort((a, b) => b.followerCount - a.followerCount);
  const uncounted = input.platforms.filter((p) => p.followerCount === null);
  if (input.platforms.length) {
    const parts = [];
    if (counted.length) parts.push(`Invite followers on ${listJoin(counted.map(countText))} to subscribe, with a profile link and regular posts that preview each issue.`);
    if (uncounted.length) parts.push(`${listJoin(uncounted.map((p) => p.platform))} profile${uncounted.length > 1 ? 's were' : ' was'} also found${counted.length ? '' : ' and can carry the same invitation'}; audience size not available.`);
    channels.push({ title: 'Existing social audience', description: parts.join(' '), basis: ['Discovered official profiles', ...(counted.length ? ['Audience summary'] : [])] });
  }
  if (input.company.website && input.company.host) {
    channels.push({
      title: 'Company website',
      description: `Add a subscribe form to ${input.company.host}, for example on the homepage and in the footer, so existing visitors can opt in.`,
      basis: [input.company.websiteReachable ? 'Company website' : 'Company website address'],
    });
  }
  for (const rule of CHANNEL_RULES) {
    if (channels.length >= max) break;
    const label = input.company.navLabels.find((l) => rule.match.test(l));
    if (label) channels.push({ title: rule.title, description: rule.description(c, label), basis: [`Website link ${quote(label)}`] });
  }
  return channels;
}

// ------------------------------------------------------------------ deterministic provider

function whyNewsletter(c) {
  const { input } = c;
  const parts = [];
  const basis = [];
  if (input.company.description) {
    parts.push(`${c.name} describes itself as ${quote(leadSentences(input.company.description))}.`);
    basis.push('Website meta description');
  } else if (c.tagline) {
    parts.push(`Based on ${poss(c.name)} public positioning (${quote(c.tagline.text)}), it already has a clear subject to write about.`);
    basis.push(c.tagline.basis);
  }
  const a = input.audience;
  if (a.total > 0) {
    parts.push(`The research found a social audience footprint of ${fmt(a.total)} followers across ${a.platformCount} platform${a.platformCount === 1 ? '' : 's'}${a.includesUserProvided ? ' (including user-provided figures)' : ''}, reach that each platform, not ${c.name}, controls.`);
    basis.push('Audience summary');
  } else if (input.platforms.length) {
    parts.push(`Official profiles were found on ${listJoin(input.platforms.map((p) => p.platform))}, though their audience sizes are not publicly available.`);
    basis.push('Discovered official profiles');
  }
  const closing = {
    'creator-platform': `A newsletter would give ${c.name} a direct, owned channel to ${c.segmentsText('its audience')}, and would show its own product in action.`.replace('channel to ', 'channel to reach '),
  }[c.archetype.id] ?? `A newsletter would give ${c.name} a direct, owned channel to reach ${c.segments.length ? c.segmentsText() : 'that audience'} on its own schedule.`;
  parts.push(closing);
  return { text: parts.join(' '), basis };
}

function detectArchetype(srcs) {
  let best = null;
  for (const a of ARCHETYPES) {
    const s = score(srcs, a.keywords);
    if (!best || s > best.score) best = { archetype: a, score: s };
  }
  // One keyword in the description or h1 (weight 3) is enough; weaker signals stay general.
  return best && best.score >= 3 ? best.archetype : GENERIC;
}

function pickThemes(c) {
  if (c.archetype === GENERIC) return genericThemes(c);
  const ranked = c.archetype.themes
    .map((t, i) => ({ t, i, s: score(c.srcs, t.keywords) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, 3)
    .sort((a, b) => b.s - a.s || a.i - b.i);
  const used = new Set();
  return ranked.map(({ t }) => {
    const hits = evidence(c.srcs, t.keywords, c.name, 2, used);
    hits.forEach((h) => used.add(lower(h.text)));
    return {
      title: t.title,
      description: hits.length ? `${t.description} Builds on what ${c.name} highlights on its website: ${listJoin(hits.map((h) => quote(h.text)))}.` : t.description,
      basis: basisOf(hits),
    };
  });
}

export const deterministicStrategyProvider = {
  id: 'deterministic-v1',
  kind: 'DETERMINISTIC',
  label: 'Rule-based generator using the research data (no AI model)',
  async generate(input) {
    const srcs = sources(input);
    const name = input.company.name;
    const archetype = detectArchetype(srcs);
    const tag = tagline(input);
    const focus = focusAreas(input);
    const segs = segments(input);
    const limited = !input.company.description && input.company.headings.length === 0;
    const c = {
      input,
      srcs,
      name,
      archetype,
      tagline: tag,
      focus,
      segments: segs,
      limited,
      taglineQuote: tag ? ` (${quote(tag.text)})` : '',
      taglinePhrase: (fallback) => (tag ? quote(tag.text) : fallback),
      focusText: (fallback) => (focus.length ? listJoin(focus.slice(0, 3).map(quote)) : fallback),
      segmentsText: (fallback) => (segs.length ? listJoin(segs.slice(0, 3)) : fallback),
    };
    c.themes = pickThemes(c);
    const issueHits = archetype.issueKeywords ? evidence(srcs, archetype.issueKeywords, name) : [];
    c.issueEvidence = issueHits.length ? ` (such as ${listJoin(issueHits.map((h) => quote(h.text)))})` : '';

    const why = whyNewsletter(c);
    const format = archetype.format(c);
    const first = archetype.firstIssue(c);
    const formatBasis = [tag?.basis, focus.length ? `Website headings ${focus.slice(0, 3).map(quote).join(', ')}` : null, segs.length ? `Audiences named on the website: ${segs.slice(0, 3).join(', ')}` : null].filter(Boolean);
    return {
      archetype: { id: archetype.id, label: archetype.label },
      dataQuality: limited ? 'LIMITED' : 'GOOD',
      whyNewsletterMakesSense: why.text,
      whyBasis: why.basis,
      recommendedFormat: { ...format, basis: formatBasis },
      contentThemes: c.themes,
      firstIssue: { ...first, basis: [...basisOf(issueHits), tag?.basis].filter(Boolean) },
      acquisitionChannels: acquisitionChannels(c),
    };
  },
};

// ------------------------------------------------------------------ validation

export class StrategyValidationError extends Error {}

function strategyText(s) {
  return [
    s.whyNewsletterMakesSense,
    s.recommendedFormat?.title,
    s.recommendedFormat?.description,
    ...(s.contentThemes ?? []).flatMap((t) => [t.title, t.description]),
    s.firstIssue?.title,
    s.firstIssue?.concept,
    ...(s.acquisitionChannels ?? []).flatMap((ch) => [ch.title, ch.description]),
  ].join('\n');
}

/**
 * Numbers a strategy may mention: figures from the audience data, and numbers that appear
 * in the company's own website text (so quoting the website stays allowed).
 */
function allowedNumbers(input) {
  const allowed = new Set();
  const add = (v) => v != null && allowed.add(String(v).replace(/,/g, '').toLowerCase());
  const a = input.audience;
  [a.total, a.platformCount].forEach(add);
  for (const p of input.platforms) {
    add(p.followerCount);
    add(p.followerCountDisplay);
  }
  const corpus = [input.company.name, input.company.host, input.company.description, ...input.company.headings.map((h) => h.text), ...input.company.navLabels].filter(Boolean).join(' ');
  for (const m of corpus.matchAll(/\d[\d,.]*[kmbt]?/gi)) add(m[0].replace(/[.,]$/, ''));
  return allowed;
}

/** Enforce the contract; throws StrategyValidationError. Returns the numbers found. */
export function validateStrategy(s, input) {
  const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
  const fail = (m) => {
    throw new StrategyValidationError(m);
  };
  if (!s || typeof s !== 'object') fail('strategy is not an object');
  if (!nonEmpty(s.whyNewsletterMakesSense)) fail('whyNewsletterMakesSense missing');
  if (!nonEmpty(s.recommendedFormat?.title) || !nonEmpty(s.recommendedFormat?.description)) fail('recommendedFormat needs title and description');
  if (!Array.isArray(s.contentThemes) || s.contentThemes.length !== 3) fail('exactly 3 content themes required');
  s.contentThemes.forEach((t, i) => (!nonEmpty(t?.title) || !nonEmpty(t?.description)) && fail(`content theme ${i + 1} needs title and description`));
  if (!nonEmpty(s.firstIssue?.title) || !nonEmpty(s.firstIssue?.concept)) fail('firstIssue needs title and concept');
  if (!Array.isArray(s.acquisitionChannels)) fail('acquisitionChannels must be an array');
  s.acquisitionChannels.forEach((ch, i) => (!nonEmpty(ch?.title) || !nonEmpty(ch?.description)) && fail(`acquisition channel ${i + 1} needs title and description`));

  const allowed = allowedNumbers(input);
  const numbers = [...strategyText(s).matchAll(/\d[\d,.]*[kmbt]?/gi)].map((m) => m[0].replace(/[.,]$/, ''));
  const invented = numbers.filter((n) => !allowed.has(n.replace(/,/g, '').toLowerCase()));
  if (invented.length) fail(`numbers not found in the research: ${[...new Set(invented)].join(', ')}`);
  return numbers;
}

// ------------------------------------------------------------------ entry point

const cache = new Map();
const CACHE_MAX = 200;
const NOTE = 'Recommendations generated from the research above — not research findings. Quoted phrases and figures come from the research; everything else is a suggestion.';

/**
 * research (a researchCompany() report, optionally with user-provided counts applied)
 *   -> { generatedBy, companyName, archetype, dataQuality, note, whyNewsletterMakesSense,
 *        whyBasis, recommendedFormat, contentThemes[3], firstIssue, acquisitionChannels }
 */
export async function generateNewsletterStrategy(research, { provider = deterministicStrategyProvider } = {}) {
  const input = buildStrategyInput(research);
  const key = `${provider.id}:${JSON.stringify(input)}`;
  if (cache.has(key)) return cache.get(key);

  let used = provider;
  let fallbackReason = null;
  let raw;
  try {
    raw = await provider.generate(input);
    validateStrategy(raw, input);
  } catch (err) {
    if (provider === deterministicStrategyProvider) throw err;
    fallbackReason = err.message;
    used = deterministicStrategyProvider;
    raw = await used.generate(input);
    validateStrategy(raw, input);
  }
  const strategy = {
    generatedBy: { id: used.id, kind: used.kind, label: used.label, ...(fallbackReason ? { fallbackFrom: provider.id, fallbackReason } : {}) },
    companyName: input.company.name,
    note: NOTE,
    ...raw,
  };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, strategy);
  return strategy;
}
