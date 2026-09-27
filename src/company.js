// Company metadata read from the homepage the engine already fetched during discovery.
// Only what the page itself states (name, description) - nothing is inferred.

function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function meta(html, key) {
  const tag = html.match(new RegExp(`<meta\\b[^>]*?(?:name|property)\\s*=\\s*["']${key}["'][^>]*>`, 'i'))?.[0];
  const c = tag?.match(/\bcontent\s*=\s*(["'])([\s\S]*?)\1/i);
  return c ? decode(c[2]) || null : null;
}

// Organization / WebSite name stated in JSON-LD, e.g. {"@type":"Organization","name":"beehiiv"}.
function jsonLdName(html) {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let found = null;
    const walk = (node) => {
      if (found || !node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      const types = [].concat(node['@type'] || []);
      if (typeof node.name === 'string' && types.some((t) => t === 'Organization' || t === 'Corporation' || t === 'WebSite')) {
        found = decode(node.name);
        return;
      }
      Object.values(node).forEach(walk);
    };
    try {
      walk(JSON.parse(m[1]));
    } catch {
      /* malformed JSON-LD is ignored */
    }
    if (found) return found;
  }
  return null;
}

function textOf(fragment) {
  return decode(fragment.replace(/<(script|style|svg|noscript)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '));
}

// Legal/cart/cookie boilerplate that says nothing about what the company does.
const BOILERPLATE = /privacy|cookie|terms of|refund|policy|added to cart|all rights|copyright|^\d+\.\s/i;

/**
 * Headings (h1-h3) as stated on the homepage, in page order, deduplicated.
 * Responsive sites often repeat a heading inside one element; that repetition is collapsed.
 */
export function extractHeadings(html, max = 30) {
  const out = [];
  const seen = new Set();
  for (const m of (html || '').matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    let text = textOf(m[2]);
    text = text.match(/^(.+?)(?:\s+\1)+$/)?.[1] ?? text;
    const key = text.toLowerCase();
    if (text.length < 3 || text.length > 200 || BOILERPLATE.test(text) || seen.has(key)) continue;
    seen.add(key);
    out.push({ level: Number(m[1]), text });
    if (out.length >= max) break;
  }
  return out;
}

/** Short link labels (navigation, footer, calls to action) as stated on the homepage. */
export function extractNavLabels(html, max = 100) {
  const out = [];
  const seen = new Set();
  for (const m of (html || '').matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = textOf(m[1]);
    const words = text.split(' ').length;
    const key = text.toLowerCase();
    if (text.length < 2 || text.length > 40 || words > 4 || /@|https?:|www\./i.test(text) || BOILERPLATE.test(text) || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

/** { name, nameSource, description, descriptionSource, headings, navLabels } from a homepage's HTML. */
export function extractCompanyInfo(html, url) {
  html = html || '';
  const host = new URL(url).hostname.replace(/^www\./, '');
  const brand = host.split('.')[0].toLowerCase();
  let name = meta(html, 'og:site_name');
  let nameSource = name ? '<meta og:site_name>' : null;
  if (!name && (name = jsonLdName(html))) nameSource = 'JSON-LD Organization/WebSite name';
  if (!name && (name = meta(html, 'application-name'))) nameSource = '<meta application-name>';
  if (!name) {
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    // "Tagline - Brand" / "Brand | Tagline": prefer the segment naming the domain's brand.
    const segments = title ? decode(title).split(/\s+[|–—-]\s+/).map((x) => x.trim()).filter(Boolean) : [];
    const pick = segments.find((x) => x.toLowerCase().replace(/[^a-z0-9]/g, '') === brand.replace(/[^a-z0-9]/g, '')) ?? segments[0];
    if (pick) {
      name = pick;
      nameSource = '<title>';
    }
  }
  if (!name) {
    name = host;
    nameSource = 'website hostname';
  }
  let description = null;
  let descriptionSource = null;
  for (const key of ['description', 'og:description']) {
    description = meta(html, key);
    if (description) {
      descriptionSource = `<meta ${key}>`;
      break;
    }
  }
  return { name, nameSource, description, descriptionSource, headings: extractHeadings(html), navLabels: extractNavLabels(html) };
}
