// Polite server-side HTTP layer.
//
// Rules enforced here (never bypassed):
//  - robots.txt is checked before every page fetch; a disallow means we do not fetch.
//  - We identify ourselves honestly; no credentials, cookies or session tokens are sent.
//  - Login walls / CAPTCHA / access-restriction responses are detected and reported,
//    never worked around.

export const USER_AGENT_TOKEN = 'SocialResearchPOC';
export const USER_AGENT =
  `Mozilla/5.0 (compatible; ${USER_AGENT_TOKEN}/0.1; public follower-count research)`;

const TIMEOUT_MS = 20000;
const robotsCache = new Map();

export class FetchOutcome {
  constructor(fields) {
    Object.assign(this, {
      ok: false,
      url: null, // requested URL
      finalUrl: null, // URL after redirects
      status: null, // HTTP status
      html: null,
      blockedReason: null, // why we could not (or chose not to) read the page
      ...fields,
    });
  }
}

const MAX_REDIRECTS = 5;

async function rawGet(url, { followRedirects = true } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: followRedirects ? 'follow' : 'manual',
      signal: ctrl.signal,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    const location = res.headers.get('location');
    const body = await res.text();
    return { status: res.status, finalUrl: res.url || url, body, location };
  } finally {
    clearTimeout(timer);
  }
}

function describeNetworkError(err) {
  // Walk the cause chain so proxy/DNS/TLS failures are reported, not just "fetch failed".
  const parts = [];
  for (let e = err, i = 0; e && i < 5; e = e.cause, i++) {
    const msg = [e.code, e.message].filter(Boolean).join(' ');
    if (msg && !parts.includes(msg)) parts.push(msg);
  }
  return parts.join(' <- ') || String(err);
}

// ---------------------------------------------------------------- robots.txt

/** Parse robots.txt into groups of { agents: [], rules: [{allow, path}] }. */
export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'allow' || key === 'disallow') {
      lastWasAgent = false;
      if (!current) continue;
      if (key === 'disallow' && value === '') continue; // empty disallow = allow all
      current.rules.push({ allow: key === 'allow', path: value });
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function ruleMatches(rulePath, path) {
  // Supports '*' wildcards and '$' end anchor per RFC 9309.
  const anchored = rulePath.endsWith('$');
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  const re = new RegExp(
    '^' + body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') +
      (anchored ? '$' : ''),
  );
  return re.test(path);
}

/** Decide whether `path` may be fetched by our user agent under parsed robots groups. */
export function isAllowedByRobots(groups, path, agentToken = USER_AGENT_TOKEN) {
  const token = agentToken.toLowerCase();
  let group = groups.find((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  if (!group) group = groups.find((g) => g.agents.includes('*'));
  if (!group) return { allowed: true, rule: null };
  let best = null;
  for (const rule of group.rules) {
    if (!ruleMatches(rule.path, path)) continue;
    const len = rule.path.length;
    // Longest match wins; on tie, Allow wins.
    if (!best || len > best.path.length || (len === best.path.length && rule.allow)) best = rule;
  }
  return { allowed: best ? best.allow : true, rule: best };
}

async function robotsFor(origin) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  let entry;
  try {
    const { status, body } = await rawGet(`${origin}/robots.txt`);
    if (status >= 200 && status < 300) entry = { groups: parseRobots(body), note: null };
    else if (status >= 400 && status < 500) entry = { groups: [], note: `robots.txt ${status}: treated as allow-all` };
    else entry = { groups: null, note: `robots.txt returned ${status}: treated as disallow-all` };
  } catch (err) {
    entry = { groups: null, note: `robots.txt unreachable: ${describeNetworkError(err)}` };
  }
  robotsCache.set(origin, entry);
  return entry;
}

// ------------------------------------------------------------ access checks

const LOGIN_URL_PATTERNS = [
  /linkedin\.com\/(authwall|login|checkpoint|uas\/login)/i,
  /instagram\.com\/accounts\/login/i,
  /facebook\.com\/(login|checkpoint)/i,
  /(x|twitter)\.com\/(i\/flow\/login|login)/i,
  /tiktok\.com\/login/i,
];

const CHALLENGE_BODY_PATTERNS = [
  /captcha/i,
  /are you a robot/i,
  /verify you are human/i,
  /cf-challenge|challenge-platform/i,
  /unusual traffic/i,
];

export function detectAccessRestriction({ status, finalUrl, html }) {
  if (LOGIN_URL_PATTERNS.some((re) => re.test(finalUrl || ''))) {
    return `redirected to a login/auth page (${finalUrl})`;
  }
  if (status === 401 || status === 403) return `HTTP ${status} (access denied)`;
  if (status === 429) return 'HTTP 429 (rate limited) - not retried';
  if (status === 999) return 'HTTP 999 (LinkedIn bot/rate restriction)';
  if (status >= 400) return `HTTP ${status}`;
  // Only treat CAPTCHA text as a block when the page is small (i.e. a challenge
  // interstitial), to avoid false positives on large pages that mention "captcha" in JS.
  if (html && html.length < 60000 && CHALLENGE_BODY_PATTERNS.some((re) => re.test(html))) {
    return 'CAPTCHA / bot-challenge page';
  }
  return null;
}

// --------------------------------------------------------------- public API

/** Fetch a public page, honouring robots.txt (on every redirect hop) and refusing to pass access controls. */
export async function politeGet(url) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed;
    try {
      parsed = new URL(current);
    } catch {
      return new FetchOutcome({ url, finalUrl: current, blockedReason: 'invalid URL' });
    }

    const robots = await robotsFor(parsed.origin);
    if (robots.groups === null) {
      return new FetchOutcome({ url, finalUrl: current, blockedReason: `not fetched - ${robots.note}` });
    }
    const verdict = isAllowedByRobots(robots.groups, parsed.pathname + parsed.search);
    if (!verdict.allowed) {
      return new FetchOutcome({
        url,
        finalUrl: current,
        blockedReason: `not fetched - disallowed by ${parsed.origin}/robots.txt (rule "Disallow: ${verdict.rule.path}")`,
      });
    }

    let res;
    try {
      res = await rawGet(current, { followRedirects: false });
    } catch (err) {
      return new FetchOutcome({ url, finalUrl: current, blockedReason: `network error: ${describeNetworkError(err)}` });
    }

    if (res.status >= 300 && res.status < 400 && res.location) {
      const next = new URL(res.location, current).toString();
      const restriction = detectAccessRestriction({ status: 200, finalUrl: next, html: '' });
      if (restriction) return new FetchOutcome({ url, finalUrl: next, status: res.status, blockedReason: restriction });
      current = next;
      continue;
    }

    const restriction = detectAccessRestriction({ status: res.status, finalUrl: current, html: res.body });
    if (restriction) {
      return new FetchOutcome({ url, finalUrl: current, status: res.status, html: res.body, blockedReason: restriction });
    }
    return new FetchOutcome({ ok: true, url, finalUrl: current, status: res.status, html: res.body });
  }
  return new FetchOutcome({ url, finalUrl: current, blockedReason: 'too many redirects' });
}
