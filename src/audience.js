// Human-in-the-loop fallback and audience totals.
//
// The research engine obtains counts automatically (AUTO_VERIFIED / SEARCH_DERIVED).
// Where it found the official profile but no reliable count, the result carries
// needsUserInput: true and the user may supply a number via applyUserProvidedCount().
// Such counts are always labelled USER_PROVIDED / UNVERIFIED and are kept apart from
// the publicly sourced total.

import { STATUS, SOURCE_TYPE, CONFIDENCE, PRECISION } from './model.js';

// Upper bound for a user-entered count. The largest social accounts are below ~1B
// followers, so anything above this is a typo rather than a real audience.
export const MAX_USER_FOLLOWER_COUNT = 1_000_000_000;

export const PLANNING_SCENARIO_PERCENTS = [1, 3, 5];

const fail = (code, message) => ({ ok: false, code, message });

/**
 * Validate a user-entered follower count. Accepts a positive integer, either as a
 * number or as a string of digits with optional comma thousands separators
 * ("22000", "22,000"). Nothing else is converted: shorthand ("22K"), decimals,
 * negatives, other separators and text are rejected with a reason code.
 *
 * Returns { ok: true, value, display } where display is the input exactly as entered
 * (trimmed), or { ok: false, code, message }.
 */
export function validateUserFollowerCount(input) {
  let value;
  let display;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return fail('NOT_A_NUMBER', 'Follower count must be a finite number.');
    if (!Number.isInteger(input)) return fail('NOT_A_WHOLE_NUMBER', 'Follower count must be a whole number.');
    value = input;
    display = String(input);
  } else if (typeof input === 'string') {
    const s = input.trim();
    display = s;
    if (s === '') return fail('EMPTY', 'Follower count is empty.');
    if (/^-/.test(s)) return fail('NOT_POSITIVE', 'Follower count must be a positive whole number.');
    if (/^\d[\d,]*\.\d*$/.test(s)) return fail('NOT_A_WHOLE_NUMBER', 'Follower count must be a whole number (no decimals).');
    if (/^\d[\d,.]*\s*[KMB]$/i.test(s)) {
      return fail('SHORTHAND_NOT_SUPPORTED', 'Enter the full number (e.g. 22000), not shorthand such as "22K".');
    }
    if (!/^\d+$/.test(s) && !/^\d{1,3}(,\d{3})+$/.test(s)) {
      return fail('MALFORMED', 'Follower count must contain only digits, optionally grouped with commas (e.g. 22,000).');
    }
    if (/^0\d/.test(s)) return fail('MALFORMED', 'Follower count must not have leading zeros.');
    value = Number(s.replace(/,/g, ''));
  } else {
    return fail('NOT_A_NUMBER', 'Follower count must be a number or a numeric string.');
  }
  if (value <= 0) return fail('NOT_POSITIVE', 'Follower count must be a positive whole number.');
  if (!Number.isSafeInteger(value) || value > MAX_USER_FOLLOWER_COUNT) {
    return fail('TOO_LARGE', `Follower count exceeds the maximum accepted value (${MAX_USER_FOLLOWER_COUNT.toLocaleString('en-US')}).`);
  }
  return { ok: true, value, display };
}

const USER_EDITABLE = [STATUS.PROFILE_FOUND_COUNT_UNAVAILABLE, STATUS.USER_PROVIDED_COUNT];

/**
 * Return a copy of `result` carrying a user-provided count. Only allowed where the
 * profile was found but no count was obtained automatically (or to correct an earlier
 * user-provided value). Automatically obtained counts are never overwritten.
 */
export function applyUserProvidedCount(result, input, { now = new Date() } = {}) {
  if (!USER_EDITABLE.includes(result.status)) {
    return fail(
      'NOT_ELIGIBLE',
      result.status === STATUS.VERIFIED_COUNT
        ? `${result.platform} already has an automatically obtained count; it is not replaced by user input.`
        : `${result.platform}: no official profile identified, so there is nothing to attach a count to.`,
    );
  }
  const v = validateUserFollowerCount(input);
  if (!v.ok) return v;
  return {
    ok: true,
    result: {
      ...result,
      status: STATUS.USER_PROVIDED_COUNT,
      followerCount: v.value,
      followerCountDisplay: v.display,
      followerCountPrecision: PRECISION.AS_PROVIDED_BY_USER,
      confidence: CONFIDENCE.UNVERIFIED,
      sourceType: SOURCE_TYPE.USER_PROVIDED,
      sourceUrl: null,
      evidence:
        `Follower count entered by the user as "${v.display}". Not observed or verified by this system; ` +
        'automated retrieval did not produce a reliable count (see attempts).',
      needsUserInput: false,
      userProvidedAt: now.toISOString(),
    },
  };
}

/**
 * Apply several user-provided counts to a report, keyed by platform key or name
 * (case-insensitive), e.g. { linkedin: '71,000', X: 12000 }. All-or-nothing: if any
 * entry is invalid, nothing is applied and every error is returned.
 */
export function applyUserProvidedCounts(report, inputs, opts = {}) {
  const results = [...report.results];
  const errors = [];
  for (const [name, input] of Object.entries(inputs)) {
    const i = results.findIndex((r) => [r.platformKey, r.platform].some((n) => n?.toLowerCase() === name.toLowerCase()));
    if (i === -1) {
      errors.push({ platform: name, code: 'UNKNOWN_PLATFORM', message: `Unknown platform "${name}".` });
      continue;
    }
    const applied = applyUserProvidedCount(results[i], input, opts);
    if (applied.ok) results[i] = applied.result;
    else errors.push({ platform: results[i].platform, code: applied.code, message: applied.message });
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, report: { ...report, results, audience: summarizeAudience(results) } };
}

function bucket(rows) {
  return {
    total: rows.reduce((s, r) => s + r.followerCount, 0),
    platformCount: rows.length,
    platforms: rows.map((r) => r.platform),
    includesRoundedValues: rows.some((r) => r.followerCountPrecision === PRECISION.ROUNDED_BY_SOURCE),
  };
}

// Status and sourceType must agree; anything else means a count of unknown origin.
function assertProvenance(r) {
  const automated = r.sourceType === SOURCE_TYPE.AUTO_VERIFIED || r.sourceType === SOURCE_TYPE.SEARCH_DERIVED;
  const ok =
    r.followerCount === null
      ? r.sourceType === null
      : Number.isInteger(r.followerCount) &&
        ((r.status === STATUS.VERIFIED_COUNT && automated) ||
          (r.status === STATUS.USER_PROVIDED_COUNT && r.sourceType === SOURCE_TYPE.USER_PROVIDED));
  if (!ok) throw new Error(`${r.platform}: follower count provenance is inconsistent (status ${r.status}, sourceType ${r.sourceType})`);
}

/**
 * Planning scenarios: fixed percentages of an audience figure, rounded half-up to a
 * whole number using integer arithmetic. They are NOT predictions of anything.
 */
export function planningScenarios(baseAudience, percents = PLANNING_SCENARIO_PERCENTS) {
  if (!Number.isInteger(baseAudience) || baseAudience <= 0) return null;
  return {
    label: 'Planning scenarios — not predictions',
    baseAudience,
    rounding: 'HALF_UP_TO_WHOLE_NUMBER',
    scenarios: percents.map((percent) => ({ percent, audienceAtPercent: Math.floor((baseAudience * percent + 50) / 100) })),
    note: 'Illustrative percentages of the Total Social Audience for planning purposes only. Social followers are not email subscribers.',
  };
}

/**
 * Structured totals with provenance, so a UI never has to reverse-engineer where a
 * number came from:
 *   publiclySourced        AUTO_VERIFIED + SEARCH_DERIVED (with a per-sourceType split)
 *   userProvided           USER_PROVIDED
 *   totalAudienceFootprint both of the above ("Total Social Audience" - not "verified")
 */
export function summarizeAudience(results) {
  results.forEach(assertProvenance);
  const withCount = results.filter((r) => r.followerCount !== null);
  const of = (...types) => withCount.filter((r) => types.includes(r.sourceType));
  const user = of(SOURCE_TYPE.USER_PROVIDED);
  const all = bucket(withCount);
  return {
    publiclySourced: {
      ...bucket(of(SOURCE_TYPE.AUTO_VERIFIED, SOURCE_TYPE.SEARCH_DERIVED)),
      bySourceType: {
        [SOURCE_TYPE.AUTO_VERIFIED]: bucket(of(SOURCE_TYPE.AUTO_VERIFIED)),
        [SOURCE_TYPE.SEARCH_DERIVED]: bucket(of(SOURCE_TYPE.SEARCH_DERIVED)),
      },
    },
    userProvided: bucket(user),
    totalAudienceFootprint: {
      label: 'Total Social Audience',
      ...all,
      includesUserProvided: user.length > 0,
      note:
        (user.length > 0 ? 'Includes publicly sourced and user-provided audience figures. ' : 'Publicly sourced audience figures only. ') +
        'A sum of follower counts across platforms, NOT a count of unique people.',
    },
    needsUserInput: results.filter((r) => r.needsUserInput).map((r) => r.platform),
    profileNotFound: results.filter((r) => r.status === STATUS.PROFILE_NOT_FOUND).map((r) => r.platform),
    planningScenarios: planningScenarios(all.total),
  };
}
