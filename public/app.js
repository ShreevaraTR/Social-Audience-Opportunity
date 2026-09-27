// Beehiiv Audience Opportunity - browser client.
//
// Presentation only. All research, validation, provenance and arithmetic come from the
// server (/api/*). The client reads the structured fields (status, sourceType,
// confidence, followerCountPrecision, needsUserInput, audience.*) and never derives
// provenance from text. External text is always rendered with textContent.

const app = document.getElementById('app');
const nf = new Intl.NumberFormat('en-US');
const fmt = (n) => nf.format(n);
const REQUEST_TIMEOUT_MS = 180_000;

const state = {
  view: 'landing', // landing | loading | results | error
  website: '',
  urlError: null,
  error: null, // { title, message, retry }
  data: null, // { analysisId, report, newsletterStrategy }
  drafts: {}, // platformKey -> text typed into a count input
  editing: {}, // platformKey -> true while editing a user-provided value
  busy: {}, // platformKey -> true while a request is in flight
  cardErrors: {}, // platformKey -> server validation message
};

// ------------------------------------------------------------------ DOM helper

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') Object.assign(el.style, v); // CSSOM, allowed under the CSP
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function render() {
  const view = { landing: renderLanding, loading: renderLoading, results: renderResults, error: renderError }[state.view];
  app.replaceChildren(view());
}

let toastTimer;
function toast(message) {
  document.querySelector('.toast')?.remove();
  const el = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite', text: message });
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3200);
}

// ------------------------------------------------------------------ API

class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    Object.assign(this, { status, code });
  }
}

async function api(method, path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (err) {
    throw err.name === 'AbortError'
      ? new RequestError(0, 'TIMEOUT', 'The analysis took too long to respond.')
      : new RequestError(0, 'NETWORK', 'We couldn’t reach the analysis service. Check your connection and try again.');
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    throw new RequestError(res.status, json?.error?.code || 'HTTP_ERROR', json?.error?.message || `The server responded with an error (${res.status}).`);
  }
  return json;
}

// ------------------------------------------------------------------ actions

function looksLikeWebsite(value) {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    return /^https?:$/.test(u.protocol) && u.hostname.includes('.');
  } catch {
    return false;
  }
}

async function analyze(website) {
  state.website = website;
  // A quick shape check for instant feedback; the server is authoritative.
  if (!website) return showUrlError('Enter your company website to begin.');
  if (!looksLikeWebsite(website)) return showUrlError('That doesn’t look like a website address. Try something like https://www.example.com/.');

  Object.assign(state, { view: 'loading', urlError: null, error: null, drafts: {}, editing: {}, busy: {}, cardErrors: {} });
  render();
  try {
    state.data = await api('POST', '/api/analyze', { website });
    state.view = 'results';
    document.title = `${state.data.report.site?.name ?? 'Results'} · Audience Opportunity`;
  } catch (err) {
    if (err.code === 'INVALID_URL') return showUrlError(err.message);
    state.view = 'error';
    state.error =
      err.code === 'NETWORK' ? { title: 'Connection problem', message: err.message, retry: true }
      : err.code === 'TIMEOUT' ? { title: 'This is taking longer than usual', message: `${err.message} Some platforms respond slowly; please try again.`, retry: true }
      : { title: 'We couldn’t complete the research', message: err.message, retry: true };
  }
  render();
  window.scrollTo({ top: 0 });
  app.focus({ preventScroll: true });
}

function showUrlError(message) {
  Object.assign(state, { view: 'landing', urlError: message });
  render();
  document.getElementById('website')?.focus();
}

function newAnalysis() {
  Object.assign(state, { view: 'landing', data: null, error: null, urlError: null });
  document.title = 'Beehiiv Audience Opportunity';
  render();
  window.scrollTo({ top: 0 });
  document.getElementById('website')?.focus();
}

async function mutateCount(result, method) {
  const key = result.platformKey;
  const { analysisId } = state.data;
  state.busy[key] = true;
  state.cardErrors[key] = null;
  render();
  try {
    const body = method === 'PUT' ? { count: state.drafts[key] ?? '' } : undefined;
    state.data = await api(method, `/api/analyses/${encodeURIComponent(analysisId)}/user-counts/${encodeURIComponent(key)}`, body);
    delete state.drafts[key];
    delete state.editing[key];
    toast(method === 'PUT' ? `${result.platform} audience saved — totals updated.` : `${result.platform} figure removed — totals updated.`);
  } catch (err) {
    if (err.code === 'ANALYSIS_NOT_FOUND') {
      state.view = 'error';
      state.error = { title: 'This analysis has expired', message: 'Analyses are kept for a limited time. Run it again to continue.', retry: true };
    } else {
      state.cardErrors[key] = err.message;
    }
  } finally {
    delete state.busy[key];
  }
  render();
  document.getElementById(`count-${key}`)?.focus();
}

// ------------------------------------------------------------------ views: landing / loading / error

function renderLanding() {
  const input = h('input', {
    id: 'website',
    class: 'input',
    type: 'text',
    inputmode: 'url',
    autocomplete: 'url',
    spellcheck: 'false',
    placeholder: 'https://www.beehiiv.com/',
    value: state.website,
    'aria-invalid': state.urlError ? 'true' : null,
    'aria-describedby': state.urlError ? 'website-error' : null,
  });
  input.value = state.website;
  const form = h(
    'form',
    {
      class: 'analyze-form',
      novalidate: true,
      onSubmit: (e) => {
        e.preventDefault();
        analyze(input.value.trim());
      },
    },
    h('label', { for: 'website', text: 'Company website' }),
    h('div', { class: 'analyze-row' }, input, h('button', { class: 'btn btn-primary', type: 'submit', text: 'Analyze Audience' })),
    state.urlError && h('p', { class: 'field-error', id: 'website-error', role: 'alert', text: state.urlError }),
  );
  return h(
    'section',
    { class: 'landing' },
    h('div', { class: 'eyebrow', text: 'Social → owned audience' }),
    h('h1', { text: 'Beehiiv Audience Opportunity' }),
    h('p', { class: 'tagline', text: 'Turn your existing social audience into an owned audience.' }),
    form,
    h(
      'ul',
      { class: 'landing-points' },
      h('li', { text: 'Publicly accessible data only' }),
      h('li', { text: 'Every figure shows its source' }),
      h('li', { text: 'Nothing estimated or invented' }),
    ),
  );
}

function renderLoading() {
  let host = state.website;
  try {
    host = new URL(/^[a-z]+:\/\//i.test(state.website) ? state.website : `https://${state.website}`).hostname.replace(/^www\./, '');
  } catch {
    /* keep raw */
  }
  const stages = ['Finding company', 'Discovering official social profiles', 'Checking publicly available audience data', 'Analyzing audience opportunity', 'Building newsletter strategy'];
  return h(
    'section',
    { class: 'state-wrap', 'aria-busy': 'true' },
    h(
      'div',
      { class: 'state-card' },
      h('div', { class: 'loading-head' }, h('div', { class: 'spinner', role: 'progressbar', 'aria-label': 'Research in progress' }), h('div', {}, h('h2', { text: `Researching ${host}` }), h('p', { text: 'This usually takes 10–60 seconds.' }))),
      h('ul', { class: 'stage-list', 'aria-label': 'What this research covers' }, stages.map((s) => h('li', {}, h('span', { class: 'stage-dot', 'aria-hidden': 'true' }), s))),
      h('p', { class: 'loading-foot', text: 'We read the company website, look for linked social profiles, and check each profile’s publicly visible audience. Platforms that restrict automated access are reported as such — never bypassed.' }),
    ),
  );
}

function renderError() {
  const { title, message, retry } = state.error;
  return h(
    'section',
    { class: 'state-wrap' },
    h(
      'div',
      { class: 'state-card', role: 'alert' },
      h('div', { class: 'state-icon', 'aria-hidden': 'true', text: '!' }),
      h('h2', { text: title }),
      h('p', { class: 'state-body', text: message }),
      h(
        'div',
        { class: 'state-actions' },
        retry && state.website && h('button', { class: 'btn btn-primary', type: 'button', text: 'Try again', onClick: () => analyze(state.website) }),
        h('button', { class: 'btn btn-secondary', type: 'button', text: 'Analyze another website', onClick: newAnalysis }),
      ),
    ),
  );
}

// ------------------------------------------------------------------ provenance presentation (from structured fields only)

const KIND = {
  auto: { card: 'is-auto', badge: ['badge-auto', 'Directly verified'], source: 'Official public profile' },
  search: { card: 'is-search', badge: ['badge-search', 'Search-derived'], source: 'Search result' },
  user: { card: 'is-user', badge: ['badge-user', 'User provided'], source: 'Entered by you' },
  missing: { card: 'is-missing', badge: ['badge-none', 'Count unavailable'], source: null },
  notfound: { card: 'is-notfound', badge: ['badge-none', 'No profile found'], source: null },
};

function kindOf(r) {
  if (r.status === 'VERIFIED_COUNT' && r.sourceType === 'AUTO_VERIFIED') return 'auto';
  if (r.status === 'VERIFIED_COUNT' && r.sourceType === 'SEARCH_DERIVED') return 'search';
  if (r.status === 'USER_PROVIDED_COUNT' && r.sourceType === 'USER_PROVIDED') return 'user';
  if (r.status === 'PROFILE_NOT_FOUND') return 'notfound';
  return 'missing';
}

const CONFIDENCE_LABEL = { HIGH: 'High confidence', MEDIUM: 'Medium confidence', LOW: 'Low confidence' };
const isRounded = (r) => r.followerCountPrecision === 'ROUNDED_BY_SOURCE';
const countText = (r) => (isRounded(r) ? r.followerCountDisplay : fmt(r.followerCount));
const PLATFORM_GLYPH = { linkedin: 'in', instagram: 'IG', x: 'X', facebook: 'f', tiktok: 'TT' };
const prettyUrl = (u) => u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');

function platformCard(r) {
  const kind = kindOf(r);
  const k = KIND[kind];
  const key = r.platformKey;
  const editing = kind === 'missing' ? r.needsUserInput : kind === 'user' && state.editing[key];

  const badges = [h('span', { class: `badge ${k.badge[0]}`, text: k.badge[1] })];
  if (kind === 'auto' || kind === 'search') {
    if (CONFIDENCE_LABEL[r.confidence]) badges.push(h('span', { class: 'badge badge-outline', text: CONFIDENCE_LABEL[r.confidence] }));
    if (isRounded(r)) badges.push(h('span', { class: 'badge badge-search', text: 'Rounded figure' }));
  }
  if (kind === 'user') badges.push(h('span', { class: 'badge badge-outline', text: 'Not independently verified' }));
  if (kind === 'missing' && r.needsUserInput) badges.push(h('span', { class: 'badge badge-input', text: 'Your input needed' }));

  const count =
    r.followerCount !== null
      ? h('div', { class: 'pc-count' }, h('span', { class: 'num', text: countText(r) }), h('span', { class: 'unit', text: 'followers' }))
      : h('div', { class: 'pc-count' }, h('span', { class: 'num is-empty', text: '—' }), h('span', { class: 'unit', text: kind === 'notfound' ? 'no profile' : 'not available' }));

  let note = null;
  if (kind === 'search' && isRounded(r)) {
    note = h('p', { class: 'pc-note note-search' }, `Reported by the source as “${r.followerCountDisplay}”, a rounded figure — the exact number isn’t published there. Counted as ${fmt(r.followerCount)} in totals.`);
  } else if (kind === 'search') {
    note = h('p', { class: 'pc-note note-search', text: 'Taken from a search result for this exact profile — not read directly from the profile page.' });
  } else if (kind === 'user') {
    note = h('p', { class: 'pc-note note-user', text: 'You entered this figure. It counts toward Total Social Audience, not toward the publicly sourced figure.' });
  } else if (kind === 'missing') {
    note = h('p', { class: 'pc-note', text: 'Official profile found, but we couldn’t reliably retrieve the follower count.' });
  } else if (kind === 'notfound') {
    note = h('p', { class: 'pc-note', text: 'We didn’t identify an official profile on this platform.' });
  }

  const facts = h(
    'dl',
    { class: 'pc-facts' },
    k.source && h('div', {}, h('dt', { text: 'Source' }), h('dd', { text: k.source })),
    r.profileDiscoveredVia && h('div', {}, h('dt', { text: 'Found via' }), h('dd', { text: r.profileDiscoveredVia })),
  );

  let form = null;
  if (editing) {
    const inputId = `count-${key}`;
    const input = h('input', {
      id: inputId,
      class: 'input input-sm',
      type: 'text',
      inputmode: 'numeric',
      autocomplete: 'off',
      placeholder: 'Enter current count',
      'aria-invalid': state.cardErrors[key] ? 'true' : null,
      'aria-describedby': `${inputId}-hint${state.cardErrors[key] ? ` ${inputId}-err` : ''}`,
      disabled: state.busy[key] || null,
      onInput: (e) => {
        state.drafts[key] = e.target.value;
      },
    });
    input.value = state.drafts[key] ?? (kind === 'user' ? r.followerCountDisplay : '');
    form = h(
      'form',
      {
        class: 'pc-form',
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          state.drafts[key] = input.value;
          mutateCount(r, 'PUT');
        },
      },
      h('label', { for: inputId, text: 'Follower count' }),
      h(
        'div',
        { class: 'pc-form-row' },
        input,
        h('button', { class: 'btn btn-primary btn-sm', type: 'submit', disabled: state.busy[key] || null, text: state.busy[key] ? 'Saving…' : kind === 'user' ? 'Save' : 'Add audience' }),
        kind === 'user' && h('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Cancel', onClick: () => { delete state.editing[key]; delete state.drafts[key]; state.cardErrors[key] = null; render(); } }),
      ),
      state.cardErrors[key]
        ? h('p', { class: 'field-error', id: `${inputId}-err`, role: 'alert', text: state.cardErrors[key] })
        : h('p', { class: 'pc-form-hint', id: `${inputId}-hint`, text: 'Whole number as shown on the profile, e.g. 12,000. It will be labeled “User provided”.' }),
    );
  }

  const actions =
    kind === 'user' && !editing
      ? h(
          'div',
          { class: 'pc-actions' },
          h('button', { class: 'btn-link', type: 'button', text: 'Edit', onClick: () => { state.editing[key] = true; render(); document.getElementById(`count-${key}`)?.focus(); } }),
          h('button', { class: 'btn-link', type: 'button', disabled: state.busy[key] || null, text: 'Remove', onClick: () => mutateCount(r, 'DELETE') }),
          state.cardErrors[key] && h('span', { class: 'field-error', role: 'alert', text: state.cardErrors[key] }),
        )
      : null;

  const evidence =
    kind !== 'notfound' &&
    h(
      'details',
      { class: 'pc-evidence pc-foot' },
      h('summary', { text: 'How we got this' }),
      h(
        'div',
        { class: 'ev-body' },
        r.evidence && h('div', { class: 'ev-quote', text: r.evidence }),
        r.sourceUrl && h('div', {}, 'Source: ', h('a', { href: r.sourceUrl, target: '_blank', rel: 'noopener noreferrer', text: prettyUrl(r.sourceUrl) })),
        r.attempts?.length > 0 && h('div', {}, h('div', { text: 'Automated checks:' }), h('ul', {}, r.attempts.map((a) => h('li', { text: `${a.source}: ${a.outcome}` })))),
        r.userProvidedAt && h('div', { text: `Entered ${new Date(r.userProvidedAt).toLocaleString()}` }),
      ),
    );

  return h(
    'article',
    { class: `card platform-card ${k.card}`, 'aria-label': `${r.platform}: ${k.badge[1]}` },
    h(
      'div',
      { class: 'pc-head' },
      h('div', { class: 'pc-icon', 'aria-hidden': 'true', text: PLATFORM_GLYPH[key] ?? r.platform[0] }),
      h(
        'div',
        { class: 'pc-title' },
        h('h3', { text: r.platform }),
        r.profileUrl
          ? h('a', { class: 'pc-url', href: r.profileUrl, target: '_blank', rel: 'noopener noreferrer', title: r.profileUrl, text: prettyUrl(r.profileUrl) })
          : h('span', { class: 'pc-url', text: 'No official profile identified' }),
      ),
    ),
    count,
    h('div', { class: 'badges' }, badges),
    note,
    facts,
    form,
    actions,
    evidence,
  );
}

// ------------------------------------------------------------------ views: results

function companyHeader(report) {
  const site = report.site ?? {};
  const url = site.finalUrl || report.companyUrl;
  return h(
    'div',
    { class: 'company-head' },
    h(
      'div',
      {},
      h('div', { class: 'eyebrow', text: 'Audience analysis' }),
      h('h1', { text: site.name || prettyUrl(url) }),
      h(
        'div',
        { class: 'company-meta' },
        h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: prettyUrl(url) }),
        h('span', { text: `Analyzed ${new Date(report.generatedAt).toLocaleString()}` }),
      ),
      site.description && h('p', { class: 'company-desc', text: site.description }),
    ),
    h('button', { class: 'btn btn-secondary', type: 'button', text: 'New analysis', onClick: newAnalysis }),
  );
}

function notices(report) {
  const out = [];
  const site = report.site ?? {};
  if (site.reachable === false) {
    out.push(
      h('div', { class: 'notice', role: 'status' }, h('div', {}, h('strong', { text: 'We couldn’t read the company website. ' }), 'Profile discovery is incomplete, so a missing profile below doesn’t mean it doesn’t exist. ', h('span', { text: `(${site.blockedReason})` }))),
    );
  }
  const unavailable = report.results.filter((r) => r.needsUserInput);
  if (unavailable.length && report.results.some((r) => r.followerCount !== null)) {
    out.push(
      h('div', { class: 'notice', role: 'status' }, h('div', {}, h('strong', { text: 'Partial results. ' }), `We found official profiles on ${unavailable.map((r) => r.platform).join(', ')} but couldn’t reliably retrieve their follower counts. You can add them below.`)),
    );
  }
  return out.length ? h('div', { class: 'notices' }, out) : null;
}

function summary(audience) {
  const total = audience.totalAudienceFootprint;
  const pub = audience.publiclySourced;
  const user = audience.userProvided;
  const auto = pub.bySourceType.AUTO_VERIFIED;
  const search = pub.bySourceType.SEARCH_DERIVED;
  const pct = (n) => (total.total > 0 ? `${(n / total.total) * 100}%` : '0');

  const totalCard = h(
    'section',
    { class: 'card summary-card summary-total', 'aria-labelledby': 'total-label' },
    h('h2', { class: 'label', id: 'total-label', text: total.label }),
    h('div', { class: 'big-number', text: total.total > 0 ? fmt(total.total) : '—' }),
    total.total > 0
      ? h(
          'div',
          { class: 'equation' },
          h('span', { class: 'pill pill-public' }, h('b', { text: fmt(pub.total) }), 'publicly sourced'),
          h('span', { class: 'op', text: '+' }),
          h('span', { class: 'pill pill-user' }, h('b', { text: fmt(user.total) }), 'user provided'),
        )
      : h('p', { class: 'summary-facts', text: 'No audience figures yet. Add counts for the profiles we found below.' }),
    h(
      'div',
      { class: 'summary-facts' },
      h('div', { text: `${total.platformCount} platform${total.platformCount === 1 ? '' : 's'} included · ${pub.platformCount} publicly sourced · ${user.platformCount} user provided` }),
      total.includesRoundedValues && h('div', { class: 'fact-rounded', text: 'Includes at least one rounded source-reported figure.' }),
      audience.needsUserInput.length > 0 && h('div', { text: `Not yet included: ${audience.needsUserInput.join(', ')} (count unavailable).` }),
    ),
    total.total > 0 &&
      h('div', { class: 'bar', 'aria-hidden': 'true' }, h('span', { class: 'seg-auto', style: { width: pct(auto.total) } }), h('span', { class: 'seg-search', style: { width: pct(search.total) } }), h('span', { class: 'seg-user', style: { width: pct(user.total) } })),
    h('p', { class: 'summary-explain', text: 'This combines publicly sourced audience figures with numbers you provided for profiles where public verification wasn’t available. It represents social audience footprint, not unique people.' }),
  );

  const row = (swatch, label, bucket) =>
    h('div', { class: 'breakdown-row' }, h('span', { class: 'key' }, h('span', { class: `swatch ${swatch}`, 'aria-hidden': 'true' }), `${label} (${bucket.platformCount})`), h('span', { class: 'val', text: fmt(bucket.total) }));

  const publicCard = h(
    'section',
    { class: 'card summary-card', 'aria-labelledby': 'public-label' },
    h('h2', { class: 'label', id: 'public-label', text: 'Publicly Sourced Audience' }),
    h('div', { class: 'mid-number', text: pub.platformCount > 0 ? fmt(pub.total) : '—' }),
    h('div', { class: 'breakdown' }, row('swatch-auto', 'Auto-verified', auto), row('swatch-search', 'Search-derived', search), h('div', { class: 'breakdown-row' }, h('span', { class: 'key' }, h('span', { class: 'swatch swatch-user', 'aria-hidden': 'true' }), `User provided (${user.platformCount}) — not included here`), h('span', { class: 'val excluded', text: fmt(user.total) }))),
    h('p', { class: 'summary-explain', text: 'Figures the research obtained itself: read directly from official public profiles, or from search results for those exact profiles. User-provided numbers are never counted here.' }),
  );
  return h('div', { class: 'summary-grid' }, totalCard, publicCard);
}

function scenarios(audience) {
  const plan = audience.planningScenarios;
  return h(
    'section',
    { class: 'section', 'aria-labelledby': 'scenarios-h' },
    h('div', { class: 'section-head' }, h('h2', { id: 'scenarios-h', text: 'Planning Scenarios' }), h('p', { text: 'Based on total social audience — not predictions.' })),
    plan
      ? [
          h('div', { class: 'scenario-grid' }, plan.scenarios.map((s) => h('div', { class: 'card scenario' }, h('div', { class: 'pct', text: `${s.percent}%` }), h('div', { class: 'val', text: `~${fmt(s.audienceAtPercent)}` }), h('div', { class: 'desc', text: `${s.percent}% of ${fmt(plan.baseAudience)} total social audience` })))),
          h('p', { class: 'scenario-note', text: `Illustrative percentages to help size a newsletter goal, not conversion predictions. ${audience.totalAudienceFootprint.includesUserProvided ? 'Includes user-provided figures. ' : ''}Social followers are not email subscribers.` }),
        ]
      : h('div', { class: 'card empty-card' }, h('h3', { text: 'No scenarios yet' }), h('p', { text: 'Planning scenarios appear once at least one audience figure is available.' })),
  );
}

function ownedVsSocial() {
  const col = (cls, title, sub, steps, foot) =>
    h('div', { class: `card compare ${cls}` }, h('h3', { text: title }), h('p', { class: 'sub', text: sub }), h('ol', { class: 'flow' }, steps.map((s) => h('li', { text: s }))), h('p', { class: 'foot', text: foot }));
  return h(
    'section',
    { class: 'section', 'aria-labelledby': 'owned-h' },
    h('div', { class: 'section-head' }, h('h2', { id: 'owned-h', text: 'Social audience vs. owned audience' }), h('p', { text: 'Why an email list complements the audience you’ve already built.' })),
    h(
      'div',
      { class: 'compare-grid' },
      col('compare-social', 'Social audience', 'Rented reach', ['You build the audience', 'Platform controls distribution', 'Reach can fluctuate'], 'Algorithms and policy changes decide how many followers see each post.'),
      col('compare-owned', 'Owned audience', 'Direct reach', ['Email subscribers', 'Direct relationship', 'Newsletter distribution'], 'Each issue is sent to subscribers’ inboxes, and the list stays with you if platforms change.'),
    ),
  );
}

function newsletterSection(strategy) {
  const head = h(
    'div',
    { class: 'section-head' },
    h('h2', { id: 'nl-h', text: 'Newsletter Strategy' }),
    h('p', { text: 'Based on the company’s website, audience footprint, and publicly available information.' }),
  );
  if (!strategy) {
    return h(
      'section',
      { class: 'section', 'aria-labelledby': 'nl-h' },
      head,
      h('div', { class: 'card empty-card' }, h('h3', { text: 'Strategy unavailable' }), h('p', { text: 'The newsletter strategy couldn’t be generated for this analysis. The research results above are unaffected.' })),
    );
  }
  // "Based on" lines list the researched facts each recommendation draws on.
  const basis = (items) => items?.length > 0 && h('p', { class: 'st-basis', text: `Based on: ${items.slice(0, 3).join(' · ')}` });
  const label = (text) => h('div', { class: 'st-label', text });

  const why = h('div', { class: 'card st-card st-wide' }, label('Why a newsletter could make sense'), h('p', { class: 'st-body', text: strategy.whyNewsletterMakesSense }), basis(strategy.whyBasis));
  const format = h(
    'div',
    { class: 'card st-card' },
    label('Recommended format'),
    h('h3', { class: 'st-title', text: strategy.recommendedFormat.title }),
    h('p', { class: 'st-body', text: strategy.recommendedFormat.description }),
    basis(strategy.recommendedFormat.basis),
  );
  const issue = h(
    'div',
    { class: 'card st-card' },
    label('First issue concept'),
    h('h3', { class: 'st-title', text: `“${strategy.firstIssue.title}”` }),
    h('p', { class: 'st-body', text: strategy.firstIssue.concept }),
    basis(strategy.firstIssue.basis),
  );
  const themes = h(
    'div',
    { class: 'st-wide' },
    label('Content themes'),
    h(
      'ol',
      { class: 'theme-grid' },
      strategy.contentThemes.map((t, i) =>
        h('li', { class: 'card theme-card' }, h('div', { class: 'theme-num', text: String(i + 1).padStart(2, '0') }), h('h3', { class: 'st-title', text: t.title }), h('p', { class: 'st-body', text: t.description }), basis(t.basis)),
      ),
    ),
  );
  const channels = h(
    'div',
    { class: 'card st-card st-wide' },
    label('Potential acquisition channels'),
    strategy.acquisitionChannels.length
      ? h('ul', { class: 'channel-grid' }, strategy.acquisitionChannels.map((c) => h('li', {}, h('div', { class: 'ch-title', text: c.title }), h('p', { class: 'st-body', text: c.description }))))
      : h('p', { class: 'st-body', text: 'Not enough research data to suggest specific channels.' }),
  );
  const g = strategy.generatedBy;
  return h(
    'section',
    { class: 'section', 'aria-labelledby': 'nl-h' },
    head,
    h('div', { class: 'strategy-grid' }, why, format, issue, themes, channels),
    h('p', { class: 'strategy-note', text: `${strategy.note} Generated by: ${g.label}.${strategy.dataQuality === 'LIMITED' ? ' Limited public information was available, so this strategy is more general than usual.' : ''}` }),
  );
}

function transparency(report) {
  const points = [
    'We use publicly accessible information.',
    'We don’t log into social platforms.',
    'We don’t bypass CAPTCHA or access controls, and we respect robots.txt.',
    'We don’t fabricate unavailable follower counts.',
    'Direct public-profile counts are distinguished from search-derived counts.',
    'User-provided figures are clearly labeled and are not independently verified.',
    'Rounded source figures remain identified as rounded.',
  ];
  return h(
    'section',
    { class: 'section', 'aria-labelledby': 'trust-h' },
    h('div', { class: 'section-head' }, h('h2', { id: 'trust-h', text: 'How we handle data' })),
    h(
      'div',
      { class: 'card trust' },
      h('ul', { class: 'trust-list' }, points.map((p) => h('li', { text: p }))),
      h('details', { class: 'notes-details' }, h('summary', { text: 'Research log' }), h('ul', {}, report.discoveryNotes.map((n) => h('li', { text: n })))),
    ),
  );
}

function renderResults() {
  const { report, newsletterStrategy } = state.data;
  const anyProfile = report.results.some((r) => r.profileFound);
  const found = report.results.filter((r) => r.profileFound);
  const notFound = report.results.filter((r) => !r.profileFound);

  const footprint = h(
    'section',
    { class: 'section', 'aria-labelledby': 'footprint-h' },
    h('div', { class: 'section-head' }, h('h2', { id: 'footprint-h', text: 'Social Audience Footprint' }), h('p', { text: 'Every official profile we found, with where each number comes from.' })),
    anyProfile
      ? h('div', { class: 'platform-grid' }, [...found, ...notFound].map(platformCard))
      : h(
          'div',
          { class: 'card empty-card' },
          h('h3', { text: 'No official social profiles found' }),
          h('p', { text: report.site?.reachable === false ? 'We couldn’t read the company website, so we couldn’t see which profiles it links to. Try the full homepage address, or try again later.' : 'The website doesn’t link to LinkedIn, Instagram, X, Facebook or TikTok profiles, and search didn’t identify official ones.' }),
          h('div', { class: 'state-actions' }, h('button', { class: 'btn btn-secondary', type: 'button', text: 'Analyze another website', onClick: newAnalysis })),
        ),
  );

  return h(
    'div',
    { class: 'container results' },
    companyHeader(report),
    notices(report),
    anyProfile && summary(report.audience),
    footprint,
    anyProfile && scenarios(report.audience),
    ownedVsSocial(),
    newsletterSection(newsletterStrategy),
    transparency(report),
  );
}

render();
