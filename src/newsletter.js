// Newsletter opportunity, built only from facts the research produced (the homepage's
// own description, discovered profiles and the audience summary).
//
// Sections that need real content analysis (format, themes, first issue) are returned
// with status NOT_GENERATED rather than filled with invented copy. A future analysis
// step can populate them without changing the shape.

import { STATUS } from './model.js';

const fmt = (n) => n.toLocaleString('en-US');

const notGenerated = (inputs) => ({
  status: 'NOT_GENERATED',
  reason: 'Requires analysis of the company’s own content, which this prototype does not perform yet.',
  inputsAvailable: inputs,
});

export function buildNewsletterOpportunity(report) {
  const { site = {}, results = [], audience } = report;
  const name = site.name || new URL(report.companyUrl).hostname;
  const withProfile = results.filter((r) => r.profileFound);
  const counted = results.filter((r) => r.followerCount !== null);
  const total = audience?.totalAudienceFootprint;

  const reasons = [];
  if (total && total.total > 0) {
    reasons.push({
      text: `${name} has a Total Social Audience of ${fmt(total.total)} across ${total.platformCount} platform${total.platformCount === 1 ? '' : 's'}${total.includesUserProvided ? ' (includes user-provided figures)' : ''}. Distribution on each of these is controlled by the platform.`,
      basis: 'audience summary',
    });
  }
  if (withProfile.length > 0) {
    reasons.push({
      text: `Official profiles found on ${withProfile.map((r) => r.platform).join(', ')}: an existing place to invite followers to subscribe.`,
      basis: 'profile discovery',
    });
  }
  if (site.description) {
    reasons.push({ text: `How ${name} describes itself: “${site.description}”`, basis: `company website ${site.descriptionSource}` });
  }

  const channels = withProfile.map((r) => ({
    channel: r.platform,
    platformKey: r.platformKey,
    url: r.profileUrl,
    followerCount: r.followerCount,
    followerCountDisplay: r.followerCountDisplay,
    followerCountPrecision: r.followerCountPrecision,
    sourceType: r.sourceType,
    note: r.status === STATUS.PROFILE_FOUND_COUNT_UNAVAILABLE ? 'Audience size not available' : null,
  }));
  if (site.reachable) channels.push({ channel: 'Company website', platformKey: 'website', url: site.finalUrl, followerCount: null, followerCountDisplay: null, followerCountPrecision: null, sourceType: null, note: 'Existing site traffic (not measured)' });

  const inputs = site.description ? ['company description'] : [];
  return {
    companyName: name,
    whyNewsletter: reasons.length ? { status: 'AVAILABLE', items: reasons } : { status: 'INSUFFICIENT_DATA', items: [] },
    format: notGenerated(inputs),
    contentThemes: notGenerated(inputs),
    acquisitionChannels: channels.length
      ? { status: 'AVAILABLE', items: channels, countedPlatforms: counted.length }
      : { status: 'INSUFFICIENT_DATA', items: [] },
    firstIssueConcept: notGenerated(inputs),
  };
}
