// Optional public web search via an official search API.
//
// We deliberately do NOT scrape search-engine HTML result pages (their terms and
// robots.txt disallow automated querying). Instead, if the operator supplies their own
// key for the Brave Search API (BRAVE_SEARCH_API_KEY), we use it. Without a key,
// search is skipped and reported as such.

import { classifyProfileUrl } from './platforms.js';
import { parseFollowerNumber } from './extractors.js';

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

async function braveSearch(query) {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) return { skipped: 'search skipped (no BRAVE_SEARCH_API_KEY configured)' };
  try {
    const res = await fetch(`${ENDPOINT}?q=${encodeURIComponent(query)}&count=10`, {
      headers: { accept: 'application/json', 'x-subscription-token': key },
    });
    if (!res.ok) return { skipped: `search API returned HTTP ${res.status}` };
    const json = await res.json();
    return { results: (json.web?.results || []).map((r) => ({ url: r.url, title: r.title || '', description: r.description || '', age: r.age || r.page_age || null })) };
  } catch (err) {
    return { skipped: `search API unreachable: ${err.message}` };
  }
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, '');
}

/** Find a likely profile via search. Marked unconfirmed: it is not linked from the company site. */
export async function searchProfile(platform, companyUrl) {
  const brand = new URL(companyUrl).hostname.replace(/^www\./, '').split('.')[0];
  const site = platform.hosts[0];
  const { results, skipped } = await braveSearch(`${brand} site:${site}`);
  if (skipped) return { note: skipped };
  for (const r of results) {
    const hit = classifyProfileUrl(r.url);
    if (!hit || hit.platform !== platform.key) continue;
    // Require the brand name in the handle to avoid picking up unrelated accounts.
    if (!hit.handle.toLowerCase().includes(brand.toLowerCase())) continue;
    return {
      profile: {
        url: hit.url,
        handle: hit.handle,
        discoveredVia: `web search result (${r.url}) - NOT linked from company website, officialness unconfirmed`,
        official: false,
        alternatives: [],
      },
    };
  }
  return { note: 'no matching profile in search results' };
}

/**
 * Secondary evidence: a search-index snippet for the exact profile URL that states
 * "N followers". This is a cached copy of the platform's own page description, so it
 * may be stale; callers must mark it as secondary / MEDIUM confidence at most.
 */
export async function searchFollowerSnippet(platformKey, profileUrl) {
  const { results, skipped } = await braveSearch(profileUrl);
  if (skipped) return { note: skipped };
  const norm = (u) => u.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
  for (const r of results) {
    const hit = classifyProfileUrl(r.url);
    if (!hit || hit.platform !== platformKey || norm(hit.url) !== norm(profileUrl)) continue;
    const text = stripTags(`${r.title} ${r.description}`);
    const m = text.match(/([\d][\d,.]*\s*[KMB]?)\s+followers\b/i);
    if (!m) continue;
    const parsed = parseFollowerNumber(m[1]);
    if (!parsed) continue;
    return {
      finding: {
        ...parsed,
        sourceUrl: r.url,
        evidence: `Search-engine snippet (Brave Search API) for ${r.url}${r.age ? `, indexed ${r.age}` : ''}: "${text.trim().slice(0, 240)}"`,
      },
    };
  }
  return { note: 'no search snippet with an explicit follower count for this exact profile' };
}
