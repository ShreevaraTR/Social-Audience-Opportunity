// Per-platform follower-count extractors.
//
// Each extractor receives the HTML of the *official profile page itself* and returns
// either null (no reliable count) or { value, display, precision, evidence }.
//
// Integrity rules baked in here:
//  - Only an explicit "followers" field/label is accepted. Likes, views, "talking about",
//    subscribers, members, hearts, engagement etc. are never used.
//  - Abbreviated numbers ("71K") are kept exactly as displayed and flagged
//    precision: 'ROUNDED_BY_SOURCE' - we never invent the missing digits.

const MULT = { K: 1e3, M: 1e6, B: 1e9 };

/** Parse "71,234" / "71.2K" / "1.5M" / "12 345". Returns null if not a clean number. */
export function parseFollowerNumber(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/ | /g, ' ');
  const abbr = s.match(/^(\d+(?:[.,]\d+)?)\s*([KMB])$/i);
  if (abbr) {
    const n = parseFloat(abbr[1].replace(',', '.'));
    return { value: Math.round(n * MULT[abbr[2].toUpperCase()]), display: s, precision: 'ROUNDED_BY_SOURCE' };
  }
  if (/^\d{1,3}([, ]\d{3})+$/.test(s) || /^\d+$/.test(s)) {
    return { value: parseInt(s.replace(/[, ]/g, ''), 10), display: s, precision: 'EXACT' };
  }
  return null;
}

function metaContent(html, nameOrProperty) {
  const re = new RegExp(
    `<meta\\b[^>]*?(?:name|property)\\s*=\\s*["']${nameOrProperty}["'][^>]*>`,
    'i',
  );
  const tag = html.match(re)?.[0];
  if (!tag) return null;
  const c = tag.match(/\bcontent\s*=\s*(["'])([\s\S]*?)\1/i);
  return c ? decodeHtml(c[2]) : null;
}

function decodeHtml(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function snippetAround(text, index, len, pad = 80) {
  const start = Math.max(0, index - pad);
  const end = Math.min(text.length, index + len + pad);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

/** Look for "<number> followers" inside the given meta tags, in order. */
function fromMetaFollowers(html, metaNames, label = 'followers') {
  const re = new RegExp(`(\\d[\\d,. \\u00a0]*\\s*[KMB]?)\\s+${label}\\b`, 'i');
  for (const name of metaNames) {
    const content = metaContent(html, name);
    if (!content) continue;
    const m = content.match(re);
    if (!m) continue;
    const parsed = parseFollowerNumber(m[1]);
    if (!parsed) continue;
    return { ...parsed, evidence: `<meta ${name}> content: "${snippetAround(content, m.index, m[0].length)}"` };
  }
  return null;
}

// ---------------------------------------------------------------- LinkedIn
// Public company pages carry e.g.
//   <meta name="description" content="beehiiv | 71,234 followers on LinkedIn. ...">
// and visible text "71,234 followers" in the top card.
export function extractLinkedIn(html) {
  const meta = fromMetaFollowers(html, ['description', 'og:description', 'twitter:description']);
  if (meta) return meta;
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ');
  // The top-card line: "<industry> · <HQ> · 71,234 followers"
  const m = text.match(/(\d[\d,]*\s*[KMB]?)\s+followers\b/i);
  if (m) {
    const parsed = parseFollowerNumber(m[1]);
    if (parsed) return { ...parsed, evidence: `Visible page text: "${snippetAround(text, m.index, m[0].length)}"` };
  }
  return null;
}

// --------------------------------------------------------------- Instagram
// Public profile HTML (when served without a login wall) has
//   <meta property="og:description" content="12K Followers, 150 Following, 900 Posts - See Instagram photos...">
export function extractInstagram(html) {
  return fromMetaFollowers(html, ['og:description', 'description']);
}

// ------------------------------------------------------------------------ X
// X profile pages are rendered client-side and the server HTML contains no counts for
// logged-out automated clients. We only accept an explicit followers_count field for the
// profile's own screen_name if one is present in the served HTML.
export function extractX(html, handle) {
  const re = new RegExp(`"screen_name"\\s*:\\s*"${handle}"[\\s\\S]{0,2000}?"followers_count"\\s*:\\s*(\\d+)`, 'i');
  const m = html.match(re);
  if (m) {
    return {
      value: parseInt(m[1], 10),
      display: m[1],
      precision: 'EXACT',
      evidence: `Embedded profile JSON: screen_name "${handle}" … "followers_count": ${m[1]}`,
    };
  }
  return null;
}

// ---------------------------------------------------------------- Facebook
// Facebook page meta descriptions often say "X likes · Y talking about this".
// LIKES ARE NOT FOLLOWERS - we only accept an explicit "followers" label.
export function extractFacebook(html) {
  const meta = fromMetaFollowers(html, ['og:description', 'description']);
  if (meta) return meta;
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ');
  const m = text.match(/(\d[\d,.]*\s*[KMB]?)\s+followers\b/i);
  if (m) {
    const parsed = parseFollowerNumber(m[1]);
    if (parsed) return { ...parsed, evidence: `Visible page text: "${snippetAround(text, m.index, m[0].length)}"` };
  }
  return null;
}

// ------------------------------------------------------------------ TikTok
// Public profile HTML embeds <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"> JSON with
// userInfo.user.uniqueId plus two stats blocks:
//   statsV2.followerCount - exact count as a string, e.g. "10962"
//   stats.followerCount   - a number TikTok may round, e.g. 11000
// We prefer statsV2. If only `stats` exists, we still report it but flag it as
// ROUNDED_BY_SOURCE, because we cannot tell whether TikTok rounded it.
// We require the uniqueId to match the handle so we never pick up another account's stats.
export function extractTikTok(html, handle) {
  const script = html.match(/<script[^>]+id=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (script) {
    try {
      const data = JSON.parse(script[1]);
      const info = data?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo;
      const uid = info?.user?.uniqueId;
      if (uid && uid.toLowerCase() === handle.toLowerCase()) {
        const isCount = (v) => v != null && /^\d+$/.test(String(v));
        const exact = info?.statsV2?.followerCount;
        const legacy = info?.stats?.followerCount;
        const prefix = `__UNIVERSAL_DATA_FOR_REHYDRATION__ → webapp.user-detail.userInfo: uniqueId "${uid}"`;
        if (isCount(exact)) {
          return {
            value: Number(exact),
            display: String(exact),
            precision: 'EXACT',
            evidence: `${prefix}, statsV2.followerCount "${exact}"${isCount(legacy) ? ` (stats.followerCount ${legacy} ignored: may be rounded)` : ''}`,
          };
        }
        if (isCount(legacy)) {
          return {
            value: Number(legacy),
            display: String(legacy),
            precision: 'ROUNDED_BY_SOURCE',
            evidence: `${prefix}, stats.followerCount ${legacy} (no statsV2 present; TikTok may round this field)`,
          };
        }
      }
    } catch {
      /* fall through to meta */
    }
  }
  return fromMetaFollowers(html, ['description', 'og:description']);
}

export const EXTRACTORS = {
  linkedin: (html) => extractLinkedIn(html),
  instagram: (html) => extractInstagram(html),
  x: (html, handle) => extractX(html, handle),
  facebook: (html) => extractFacebook(html),
  tiktok: (html, handle) => extractTikTok(html, handle),
};
