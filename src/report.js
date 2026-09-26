import { STATUS } from './research.js';

const fmt = (n) => n.toLocaleString('en-US');

function followersLine(r) {
  if (r.status !== STATUS.VERIFIED_COUNT) return 'Not verified';
  if (r.followerCountPrecision === 'ROUNDED_BY_SOURCE') {
    return `${r.followerCountDisplay} (rounded by the source itself; exact figure not published there)`;
  }
  return fmt(r.followerCount);
}

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
    if (r.sourceType) lines.push(`Source type: ${r.sourceType}${r.sourceType !== 'OFFICIAL_PROFILE' ? ' (secondary - not directly observed on the profile)' : ''}`);
    lines.push(`Source: ${r.sourceUrl ?? '-'}`);
    lines.push(`Evidence: ${r.evidence}`);
    for (const a of r.attempts) lines.push(`  attempt: ${a.source} -> ${a.outcome}`);
    lines.push('');
  }

  lines.push('Verified follower counts:');
  const verified = report.results.filter((r) => r.status === STATUS.VERIFIED_COUNT);
  for (const r of report.results) {
    lines.push(`${r.platform}: ${r.status === STATUS.VERIFIED_COUNT ? `${followersLine(r)} [${r.confidence}]` : 'Not verified'}`);
  }
  lines.push('');
  if (verified.length === 0) {
    lines.push('No verified follower counts - no combined total calculated.');
  } else if (verified.length === 1) {
    lines.push(`Only one verified count (${verified[0].platform}) - no combined total calculated.`);
  } else {
    const total = verified.reduce((s, r) => s + r.followerCount, 0);
    const rounded = verified.some((r) => r.followerCountPrecision === 'ROUNDED_BY_SOURCE');
    lines.push(`Combined Verified Social Following: ${fmt(total)}${rounded ? ' (includes source-rounded values)' : ''}`);
    lines.push(`  across ${verified.map((r) => r.platform).join(', ')}.`);
    lines.push('  Note: this is a sum of follower counts, NOT a count of unique people - audiences overlap across platforms.');
  }
  return lines.join('\n');
}
