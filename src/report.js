import { STATUS, SOURCE_TYPE, PRECISION } from './model.js';
import { summarizeAudience } from './audience.js';

const fmt = (n) => n.toLocaleString('en-US');

function followersLine(r) {
  if (r.status === STATUS.USER_PROVIDED_COUNT) return `${r.followerCountDisplay} (user-provided; not verified)`;
  if (r.status !== STATUS.VERIFIED_COUNT) return 'Not verified';
  if (r.followerCountPrecision === PRECISION.ROUNDED_BY_SOURCE) {
    return `${r.followerCountDisplay} (rounded by the source itself; exact figure not published there)`;
  }
  return fmt(r.followerCount);
}

const SOURCE_NOTE = {
  [SOURCE_TYPE.AUTO_VERIFIED]: '',
  [SOURCE_TYPE.SEARCH_DERIVED]: ' (secondary - not directly observed on the profile)',
  [SOURCE_TYPE.USER_PROVIDED]: ' (entered by the user - not observed or verified by this system)',
};

export function renderText(report) {
  const lines = [];
  lines.push('Social Research Results', '=======================', '');
  lines.push(`Company: ${report.companyUrl}`, `Run at:  ${report.generatedAt}`, '');
  lines.push('Discovery notes:');
  for (const n of report.discoveryNotes) lines.push(`  - ${n}`);
  lines.push('');

  for (const r of report.results) {
    lines.push(r.platform);
    lines.push(`Profile: ${r.profileUrl ?? 'Not found'}`);
    if (r.profileDiscoveredVia) lines.push(`Found via: ${r.profileDiscoveredVia}`);
    lines.push(`Status: ${r.status}`);
    lines.push(`Followers: ${followersLine(r)}`);
    lines.push(`Confidence: ${r.confidence}`);
    if (r.sourceType) lines.push(`Source type: ${r.sourceType}${SOURCE_NOTE[r.sourceType]}`);
    lines.push(`Source: ${r.sourceUrl ?? '-'}`);
    lines.push(`Evidence: ${r.evidence}`);
    for (const a of r.attempts) lines.push(`  attempt: ${a.source} -> ${a.outcome}`);
    lines.push('');
  }

  lines.push('Verified follower counts:');
  const verified = report.results.filter((r) => r.status === STATUS.VERIFIED_COUNT);
  for (const r of report.results) {
    const line =
      r.status === STATUS.VERIFIED_COUNT ? `${followersLine(r)} [${r.confidence}]`
      : r.status === STATUS.USER_PROVIDED_COUNT ? `Not verified; ${followersLine(r)}`
      : r.needsUserInput ? 'Not verified (a count may be entered manually)'
      : 'Not verified';
    lines.push(`${r.platform}: ${line}`);
  }
  lines.push('');
  if (verified.length === 0) {
    lines.push('No verified follower counts - no combined total calculated.');
  } else if (verified.length === 1) {
    lines.push(`Only one verified count (${verified[0].platform}) - no combined total calculated.`);
  } else {
    const total = verified.reduce((s, r) => s + r.followerCount, 0);
    const rounded = verified.some((r) => r.followerCountPrecision === PRECISION.ROUNDED_BY_SOURCE);
    lines.push(`Combined Verified Social Following: ${fmt(total)}${rounded ? ' (includes source-rounded values)' : ''}`);
    lines.push(`  across ${verified.map((r) => r.platform).join(', ')}.`);
    lines.push('  Note: this is a sum of follower counts, NOT a count of unique people - audiences overlap across platforms.');
  }

  const audience = report.audience ?? summarizeAudience(report.results);
  const { totalAudienceFootprint: total, publiclySourced, userProvided, planningScenarios: plan } = audience;
  if (userProvided.platformCount > 0) {
    lines.push('');
    lines.push(`${total.label}: ${fmt(total.total)} (includes publicly sourced and user-provided figures; not verified as a whole)`);
    lines.push(`  Publicly sourced: ${fmt(publiclySourced.total)} across ${publiclySourced.platformCount} platform(s)${publiclySourced.includesRoundedValues ? ', includes source-rounded values' : ''}`);
    lines.push(`  User provided:    ${fmt(userProvided.total)} across ${userProvided.platformCount} platform(s): ${userProvided.platforms.join(', ')}`);
  }
  if (plan) {
    lines.push('');
    lines.push(`${plan.label} (based on ${fmt(plan.baseAudience)} total social audience):`);
    for (const s of plan.scenarios) lines.push(`  ${s.percent}% = ${fmt(s.audienceAtPercent)}`);
    lines.push(`  ${plan.note}`);
  }
  return lines.join('\n');
}
