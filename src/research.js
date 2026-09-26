// Orchestrator: company URL -> one structured, sourced result per platform.

import { discoverProfiles } from './discover.js';
import { politeGet } from './http.js';
import { EXTRACTORS } from './extractors.js';
import { PLATFORMS } from './platforms.js';
import { searchFollowerSnippet } from './search.js';
import { STATUS, SOURCE_TYPE, CONFIDENCE } from './model.js';
import { summarizeAudience } from './audience.js';

export { STATUS, SOURCE_TYPE, CONFIDENCE, PRECISION } from './model.js';

const AUTOMATED_SOURCE_TYPES = [SOURCE_TYPE.AUTO_VERIFIED, SOURCE_TYPE.SEARCH_DERIVED];

/**
 * Build a result object. This is the single place statuses are assigned, so the
 * integrity invariants hold for every platform:
 *   - no profile  -> PROFILE_NOT_FOUND, count null, NOT_AVAILABLE
 *   - no finding  -> PROFILE_FOUND_COUNT_UNAVAILABLE, count null, NOT_AVAILABLE
 *   - a count is only ever emitted together with a sourceUrl and evidence
 *   - only automated findings (AUTO_VERIFIED / SEARCH_DERIVED) enter here; user-provided
 *     counts go through applyUserProvidedCount() in audience.js and never become VERIFIED_COUNT
 */
export function buildResult({ platform, profile, finding, attempts = [], notFoundReason = null }) {
  const base = {
    platform: platform.name,
    platformKey: platform.key,
    profileFound: false,
    profileUrl: null,
    profileDiscoveredVia: null,
    followerCount: null,
    followerCountDisplay: null,
    followerCountPrecision: null,
    confidence: CONFIDENCE.NOT_AVAILABLE,
    sourceType: null,
    sourceUrl: null,
    status: STATUS.PROFILE_NOT_FOUND,
    evidence: null,
    // true when the profile is known but no count could be obtained automatically:
    // the caller may then supply one via applyUserProvidedCount().
    needsUserInput: false,
    userProvidedAt: null,
    attempts,
    retrievedAt: new Date().toISOString(),
  };
  if (!profile) {
    return { ...base, evidence: `No official profile identified.${notFoundReason ? ` ${notFoundReason}` : ''}` };
  }
  const withProfile = {
    ...base,
    profileFound: true,
    profileUrl: profile.url,
    profileDiscoveredVia: profile.discoveredVia,
    status: STATUS.PROFILE_FOUND_COUNT_UNAVAILABLE,
  };
  const valid =
    finding &&
    Number.isInteger(finding.value) &&
    finding.value >= 0 &&
    finding.sourceUrl &&
    finding.evidence &&
    AUTOMATED_SOURCE_TYPES.includes(finding.sourceType);
  if (!valid) {
    return {
      ...withProfile,
      needsUserInput: true,
      sourceUrl: profile.url,
      evidence: `Profile identified (${profile.discoveredVia}); no reliable public follower count could be retrieved. See attempts.`,
    };
  }

  // Confidence: direct observation on the official profile = HIGH; secondary
  // (e.g. search snippet) = MEDIUM; either one on a profile whose officialness is
  // unconfirmed is capped one level lower.
  let confidence = finding.sourceType === SOURCE_TYPE.AUTO_VERIFIED ? CONFIDENCE.HIGH : CONFIDENCE.MEDIUM;
  if (!profile.official) confidence = confidence === CONFIDENCE.HIGH ? CONFIDENCE.MEDIUM : CONFIDENCE.LOW;

  return {
    ...withProfile,
    followerCount: finding.value,
    followerCountDisplay: finding.display,
    followerCountPrecision: finding.precision,
    confidence,
    sourceType: finding.sourceType,
    sourceUrl: finding.sourceUrl,
    status: STATUS.VERIFIED_COUNT,
    evidence: finding.evidence,
  };
}

async function researchPlatform(platform, profile, { useSearch, notFoundReason }) {
  const attempts = [];
  if (!profile) return buildResult({ platform, profile, attempts, notFoundReason });

  // 1. Direct observation on the official profile page.
  const page = await politeGet(profile.url);
  if (page.ok) {
    const hit = EXTRACTORS[platform.key](page.html, profile.handle);
    if (hit) {
      return buildResult({
        platform,
        profile,
        attempts: [...attempts, { source: profile.url, outcome: `HTTP ${page.status}; follower count found` }],
        finding: { ...hit, sourceType: SOURCE_TYPE.AUTO_VERIFIED, sourceUrl: page.finalUrl },
      });
    }
    attempts.push({ source: profile.url, outcome: `HTTP ${page.status}; page readable but no explicit follower count present` });
  } else {
    attempts.push({ source: profile.url, outcome: page.blockedReason });
  }

  // 2. Secondary: search-index snippet for the exact profile URL.
  if (useSearch) {
    const s = await searchFollowerSnippet(platform.key, profile.url);
    if (s.finding) {
      return buildResult({
        platform,
        profile,
        attempts: [...attempts, { source: 'Brave Search API', outcome: 'snippet with follower count found' }],
        finding: { ...s.finding, sourceType: SOURCE_TYPE.SEARCH_DERIVED },
      });
    }
    attempts.push({ source: 'Brave Search API', outcome: s.note });
  }
  return buildResult({ platform, profile, attempts });
}

export async function researchCompany(companyUrl, { useSearch = true } = {}) {
  const discovery = await discoverProfiles(companyUrl, { useSearch });
  const notFoundReason = discovery.siteFetch.ok
    ? 'The company website does not link one, and search did not find one.'
    : `Discovery was incomplete: the company website could not be read (${discovery.siteFetch.blockedReason}). This does NOT show the profile does not exist.`;
  const results = [];
  for (const platform of PLATFORMS) {
    results.push(await researchPlatform(platform, discovery.profiles[platform.key], { useSearch, notFoundReason }));
  }
  return {
    companyUrl,
    generatedAt: new Date().toISOString(),
    discoveryNotes: discovery.notes,
    results,
    audience: summarizeAudience(results),
  };
}
