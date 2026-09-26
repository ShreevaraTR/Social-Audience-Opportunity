// Shared vocabulary for per-platform results. research.js re-exports these, so existing
// `import { STATUS } from './research.js'` keeps working.

export const STATUS = {
  // A count the system obtained itself (see sourceType for how).
  VERIFIED_COUNT: 'VERIFIED_COUNT',
  // A count the user entered because the system could not retrieve one. Never "verified".
  USER_PROVIDED_COUNT: 'USER_PROVIDED_COUNT',
  PROFILE_FOUND_COUNT_UNAVAILABLE: 'PROFILE_FOUND_COUNT_UNAVAILABLE',
  PROFILE_NOT_FOUND: 'PROFILE_NOT_FOUND',
};

// Where a followerCount came from. Every non-null followerCount carries exactly one.
export const SOURCE_TYPE = {
  // Read directly from the publicly accessible official profile page.
  AUTO_VERIFIED: 'AUTO_VERIFIED',
  // Read from a search-engine snippet for the exact profile URL (secondary, may be stale).
  SEARCH_DERIVED: 'SEARCH_DERIVED',
  // Entered manually by the user; not observed or checked by the system.
  USER_PROVIDED: 'USER_PROVIDED',
};

// The system's confidence in its own observation. USER_PROVIDED counts get UNVERIFIED:
// the system has no evidence either way, so it must not claim HIGH/MEDIUM/LOW.
export const CONFIDENCE = {
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  UNVERIFIED: 'UNVERIFIED',
  NOT_AVAILABLE: 'NOT_AVAILABLE',
};

// followerCountPrecision: how exact followerCount is.
export const PRECISION = {
  EXACT: 'EXACT',
  // The source itself displayed an abbreviation such as "22K". followerCount holds the
  // numeric reading (22000) for arithmetic; followerCountDisplay keeps "22K".
  ROUNDED_BY_SOURCE: 'ROUNDED_BY_SOURCE',
  // A whole number as the user typed it; the system cannot say whether it is exact.
  AS_PROVIDED_BY_USER: 'AS_PROVIDED_BY_USER',
};
