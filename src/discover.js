// Discover a company's official social profiles.
//
// Primary evidence: links (and JSON-LD `sameAs`) on the company's own website - the
// company itself asserting "this is our profile". Search results are only a fallback
// and are marked as lower-certainty in the evidence.

import { politeGet } from './http.js';
import { classifyProfileUrl, PLATFORMS } from './platforms.js';
import { searchProfile } from './search.js';

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#47;/g, '/');
}

/** Extract every candidate URL from anchors and JSON-LD sameAs on a page. */
export function extractLinks(html, baseUrl) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1/gis)) {
    out.push({ href: decodeEntities(m[2]), via: 'anchor' });
  }
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (node) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (node && typeof node === 'object') {
          const same = node.sameAs;
          if (typeof same === 'string') out.push({ href: same, via: 'json-ld sameAs' });
          if (Array.isArray(same)) same.forEach((s) => out.push({ href: String(s), via: 'json-ld sameAs' }));
          Object.values(node).forEach(walk);
        }
      };
      walk(JSON.parse(m[1]));
    } catch {
      /* malformed JSON-LD is ignored */
    }
  }
  return out
    .map((l) => {
      try {
        return { ...l, href: new URL(l.href, baseUrl).toString() };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function brandTokens(companyUrl) {
  const host = new URL(companyUrl).hostname.replace(/^www\./, '');
  const base = host.split('.')[0].toLowerCase();
  return [base];
}

/**
 * Given links from the company site, choose at most one profile per platform.
 * When a site links several accounts on one platform, prefer the one whose handle
 * matches the brand, then the one linked most often.
 */
export function pickProfiles(links, companyUrl) {
  const brand = brandTokens(companyUrl);
  const byPlatform = new Map();
  for (const link of links) {
    const hit = classifyProfileUrl(link.href);
    if (!hit) continue;
    const list = byPlatform.get(hit.platform) || [];
    const existing = list.find((c) => c.url.toLowerCase() === hit.url.toLowerCase());
    if (existing) {
      existing.count++;
      existing.via.add(link.via);
    } else {
      list.push({ ...hit, count: 1, via: new Set([link.via]) });
    }
    byPlatform.set(hit.platform, list);
  }
  const picked = {};
  for (const [platform, list] of byPlatform) {
    list.sort((a, b) => {
      const am = brand.some((t) => a.handle.toLowerCase().includes(t)) ? 1 : 0;
      const bm = brand.some((t) => b.handle.toLowerCase().includes(t)) ? 1 : 0;
      return bm - am || b.count - a.count;
    });
    const best = list[0];
    picked[platform] = {
      url: best.url,
      handle: best.handle,
      discoveredVia: `company website (${[...best.via].join(', ')})`,
      official: true,
      alternatives: list.slice(1).map((c) => c.url),
    };
  }
  return picked;
}

/** Discover profiles for a company. Returns { profiles, siteFetch, notes }. */
export async function discoverProfiles(companyUrl, { useSearch = true } = {}) {
  const notes = [];
  const siteFetch = await politeGet(companyUrl);
  let profiles = {};
  if (siteFetch.ok) {
    profiles = pickProfiles(extractLinks(siteFetch.html, siteFetch.finalUrl), companyUrl);
    notes.push(`Fetched company website ${siteFetch.finalUrl} (HTTP ${siteFetch.status}).`);
  } else {
    notes.push(`Could not read company website ${companyUrl}: ${siteFetch.blockedReason}.`);
  }

  if (useSearch) {
    for (const p of PLATFORMS) {
      if (profiles[p.key]) continue;
      const found = await searchProfile(p, companyUrl);
      if (found.note) notes.push(`${p.name} search: ${found.note}`);
      if (found.profile) profiles[p.key] = found.profile;
    }
  }
  return { profiles, siteFetch, notes };
}
