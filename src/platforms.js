// Platform definitions: how to recognise an official *profile* URL (as opposed to a
// share button, post, or intent link) and how to normalise it.

export const PLATFORMS = [
  {
    key: 'linkedin',
    name: 'LinkedIn',
    hosts: ['linkedin.com'],
    // Company / showcase / school pages only - personal /in/ pages are not company profiles.
    match: (u) => {
      const m = u.pathname.match(/^\/(company|showcase|school)\/([^/?#]+)/i);
      return m ? { handle: m[2], url: `https://www.linkedin.com/${m[1].toLowerCase()}/${m[2]}/` } : null;
    },
  },
  {
    key: 'instagram',
    name: 'Instagram',
    hosts: ['instagram.com'],
    match: (u) => {
      const m = u.pathname.match(/^\/([A-Za-z0-9._]+)\/?$/);
      const reserved = ['p', 'reel', 'reels', 'explore', 'accounts', 'stories', 'direct', 'tv', 'share'];
      if (!m || reserved.includes(m[1].toLowerCase())) return null;
      return { handle: m[1], url: `https://www.instagram.com/${m[1]}/` };
    },
  },
  {
    key: 'x',
    name: 'X',
    hosts: ['x.com', 'twitter.com'],
    match: (u) => {
      const m = u.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
      const reserved = ['intent', 'share', 'home', 'search', 'i', 'hashtag', 'login', 'explore', 'settings'];
      if (!m || reserved.includes(m[1].toLowerCase())) return null;
      return { handle: m[1], url: `https://x.com/${m[1]}` };
    },
  },
  {
    key: 'facebook',
    name: 'Facebook',
    hosts: ['facebook.com', 'fb.com'],
    match: (u) => {
      if (/^\/(sharer|share|dialog|plugins|login|groups|events|watch|hashtag)/i.test(u.pathname)) return null;
      if (/^\/profile\.php$/i.test(u.pathname) && u.searchParams.get('id')) {
        const id = u.searchParams.get('id');
        return { handle: id, url: `https://www.facebook.com/profile.php?id=${id}` };
      }
      const m = u.pathname.match(/^\/(?:pg\/)?([A-Za-z0-9.\-]+)\/?$/);
      if (!m) return null;
      return { handle: m[1], url: `https://www.facebook.com/${m[1]}` };
    },
  },
  {
    key: 'tiktok',
    name: 'TikTok',
    hosts: ['tiktok.com'],
    match: (u) => {
      const m = u.pathname.match(/^\/@([A-Za-z0-9._]+)\/?$/);
      return m ? { handle: m[1], url: `https://www.tiktok.com/@${m[1]}` } : null;
    },
  },
];

export function platformByKey(key) {
  return PLATFORMS.find((p) => p.key === key);
}

/** Classify an absolute URL as a profile on one of our platforms, or null. */
export function classifyProfileUrl(href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|[a-z]{2}(-[a-z]{2})?)\./, '');
  for (const p of PLATFORMS) {
    if (!p.hosts.includes(host)) continue;
    const hit = p.match(u);
    if (hit) return { platform: p.key, ...hit };
  }
  return null;
}
