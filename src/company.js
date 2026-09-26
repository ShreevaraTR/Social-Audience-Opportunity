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

/** { name, nameSource, description, descriptionSource } from a homepage's HTML. */
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
  return { name, nameSource, description, descriptionSource };
}
